#include <algorithm>
#include <bit>
#include <cmath>
#include <container_helpers.h>
#include <eigen3/Eigen/Dense>
#include <initializer_list>
#include <nanoflann.hpp>
#include <numbers>
#include <ranges>
#include <splat/splat.h>
#include <splat/splat_lod.h>
#include <thread>
#include <tuple>
#include <vector>

namespace {
constexpr double TWO_PI_POW_1_5 = 0x1.f7fccep+3;
constexpr double EPS_COV = 1e-8;
constexpr double LOG_2PI = 1.8378771;
constexpr float OPACITY_PRUNE_THRESHOLD = 0.005f;

class GaussianCloud {
public:
    GaussianCloud(const splat::Splat& splat) : splat(splat) {}

    inline size_t kdtree_get_point_count() const { return splat.gaussians.size(); }
    inline float kdtree_get_pt(size_t i, int d) const { return splat.gaussians[i].mean[d]; }
    template<class BBOX>
    bool kdtree_get_bbox(BBOX&) const { return false; }

private:
    const splat::Splat& splat;
};

struct GaussianCache {
    Eigen::Matrix3d rotation;
    Eigen::Matrix3d rotation_transpose;
    Eigen::Matrix3d sigma;
    Eigen::Vector3d variances;
    Eigen::Vector3d inv_diag;
    double log_det;
    double mass;
};

using KDTree = nanoflann::KDTreeSingleIndexAdaptor<
    nanoflann::L2_Simple_Adaptor<float, GaussianCloud>,
    GaussianCloud, 3>;

// https://github.com/graphdeco-inria/gaussian-hierarchy/
static splat::Gaussian merge_gaussians(const splat::Splat& input, const std::vector<uint32_t>& idx, float scale_boost) {
    splat::Gaussian out;
    out.mean.setZero();
    out.covariance.setZero();
    out.scale.setZero();
    out.rotation.setZero();
    out.sh = splat::SH(input.gaussians[0].sh.size());
    out.sh.set_zero();
    out.opacity = 0.0;

    std::vector<float> weights(idx.size());
    float total_weight = 0.0f;

    for (auto i = 0; i < idx.size(); i++) {
        const auto& g = input.gaussians[idx[i]];
        weights[i] = g.area() * g.opacity;
        total_weight += weights[i];
    }

    for (auto& weight : weights) {
        weight /= total_weight;
    }

    for (auto i = 0; i < idx.size(); i++) {
        const auto& g = input.gaussians[idx[i]];
        out.mean += g.mean * weights[i];
        out.sh.add_multiplied(g.sh, weights[i]);
    }

    for (auto i = 0; i < idx.size(); i++) {
        const auto& g = input.gaussians[idx[i]];
        auto d = g.mean - out.mean;
        out.covariance += weights[i] * (g.covariance + d * d.transpose());
    }

    out.decompose_covariance();
    out.scale *= scale_boost;
    out.opacity = total_weight / out.area();

    if (out.opacity > 1.0f) {
        out.scale *= std::pow(out.opacity, 1.0f / 3.0f);
        out.opacity = 1.0;
    }
    out.compute_covariance();

    return out;
}

static Eigen::Matrix3d sigma_from_rotation_variances(const Eigen::Matrix3d& rotation, const Eigen::Vector3d& variances) {
    Eigen::Matrix3d s = Eigen::Matrix3d::Identity();

    s(0, 0) = variances.x();
    s(1, 1) = variances.y();
    s(2, 2) = variances.z();

    return rotation * s * rotation.transpose();
}

static void build_cache(const splat::Splat& splat, std::vector<GaussianCache>& caches) {
    static Eigen::Vector3d VECTOR_ONE(1.0, 1.0, 1.0);
    static Eigen::Vector3d VECTOR_EPS(EPS_COV, EPS_COV, EPS_COV);

    for (auto& gaussian : splat.gaussians) {
        auto rotation = Eigen::Matrix3d(Eigen::Quaterniond(gaussian.rotation.w(), gaussian.rotation.x(), gaussian.rotation.y(), gaussian.rotation.z()));
        auto t = rotation.transpose();
        Eigen::Vector3f vf = gaussian.scale.cwiseMax(1e-12f).cwiseSquare();
        Eigen::Vector3d v = Eigen::Vector3d(vf.x(), vf.y(), vf.z()) + VECTOR_EPS;
        Eigen::Vector3d safe_v = v.cwiseMax(1e-30);

        caches.push_back(GaussianCache {
            .rotation = rotation,
            .rotation_transpose = t,
            .sigma = sigma_from_rotation_variances(rotation, v),
            .variances = v,
            .inv_diag = VECTOR_ONE.array() / safe_v.array(),
            .log_det = safe_v.array().log().sum(),
            .mass = TWO_PI_POW_1_5 * gaussian.opacity * gaussian.scale.prod() + 1e-12 });
    }
}

std::vector<Eigen::Vector3d> make_gaussian_samples(size_t n, uint32_t seed) {
    std::vector<Eigen::Vector3d> result;
    result.reserve(n);
    auto rand = [&seed]() -> double {
        auto t = (seed += 0x6d2b79f5);
        t = (t ^ (t >> 15)) * (t | 1);
        t ^= t + (t ^ (t >> 7)) * (t | 61);
        return static_cast<double>((t ^ (t >> 14)) >> 0) / 4294967296.0;
    };

    for (auto i = 0; i < n; i++) {
        auto u1 = std::max(rand(), 1e-12);
        auto u2 = rand();
        auto u3 = std::max(rand(), 1e-12);
        auto u4 = rand();
        auto r1 = std::sqrt(-2 * std::log(u1));
        auto t1 = 2 * std::numbers::pi_v<double> * u2;
        auto r2 = std::sqrt(-2 * std::log(u3));
        auto t2 = 2 * std::numbers::pi_v<double> * u4;
        result.emplace_back(r1 * std::cos(t1), r1 * std::sin(t1), r2 * std::cos(t2));
    }

    return result;
}

static double gauss_log_pdf_diagrot(const Eigen::Vector3d& v, const Eigen::Vector3d& m, const Eigen::Matrix3d& r, const Eigen::Vector3d& inv, double log_det) {
    Eigen::Vector3d d = v - m;
    Eigen::Vector3d y = r * d;
    double quad = y.cwiseSquare().transpose() * inv;
    return -0.5 * (3.0 * LOG_2PI + log_det + quad);
}

static double log_add_exp(double a, double b) {
    if (-std::numeric_limits<double>::infinity() == a) {
        return b;
    }
    if (-std::numeric_limits<double>::infinity() == b) {
        return a;
    }
    auto m = std::max(a, b);
    return m + std::log(std::exp(a - m) + std::exp(b - m));
};

static double compute_edge_cost(const splat::Splat& splat, const std::vector<GaussianCache>& caches, const std::vector<Eigen::Vector3d>& samples, std::tuple<uint32_t, uint32_t>& edge) {
    auto [i, j] = edge;
    auto& u = splat.gaussians[i];
    auto& v = splat.gaussians[j];
    auto& cache_i = caches[i];
    auto& cache_j = caches[j];
    auto wi = cache_i.mass;
    auto wj = cache_j.mass;
    auto w = wi + wj;
    auto w_safe = w > 0 ? w : 1;
    auto pi = wi / w_safe;
    pi = std::max(1e-12, std::min(1.0 - 1e-12, pi));
    auto pj = 1 - pi;
    auto log_pi = std::log(pi);
    auto log_pj = std::log(pj);
    Eigen::Vector3d u_mean(u.mean.x(), u.mean.y(), u.mean.z());
    Eigen::Vector3d v_mean(v.mean.x(), v.mean.y(), v.mean.z());

    auto mm = pi * u_mean + pj * v_mean;
    auto di = u_mean - mm;
    auto dj = v_mean - mm;
    Eigen::Matrix3d sigma = pi * cache_i.sigma + pj * cache_j.sigma;

    sigma += pi * (di * di.transpose()) + pj * (dj * dj.transpose());

    // Force symmetry + regularize
    sigma(0, 1) = sigma(1, 0) = 0.5 * (sigma(0, 1) + sigma(1, 0));
    sigma(0, 2) = sigma(2, 0) = 0.5 * (sigma(0, 2) + sigma(2, 0));
    sigma(1, 2) = sigma(2, 1) = 0.5 * (sigma(1, 2) + sigma(2, 1));

    sigma(0, 0) += EPS_COV;
    sigma(1, 1) += EPS_COV;
    sigma(2, 2) += EPS_COV;

    // det should never be neg.
    auto det_m = std::max(sigma.determinant(), 1e-30);
    auto log_det_m = std::log(det_m);
    // E_p[-log q_m] computed analytically as entropy of merged Gaussian
    auto ep_neg_log_q = 0.5 * (3.0 * LOG_2PI + log_det_m + 3.0);

    // Sample from each component separately with same z-vectors
    Eigen::Vector3d std_i = cache_i.variances.cwiseMax(0).cwiseSqrt();
    Eigen::Vector3d std_j = cache_j.variances.cwiseMax(0).cwiseSqrt();

    auto sum_log_p_on_i = 0.0;
    auto sum_log_p_on_j = 0.0;

    for (auto& sample : samples) {
        Eigen::Vector3d ti = std_i.array() * sample.array();
        Eigen::Vector3d tj = std_j.array() * sample.array();
        Eigen::Vector3d xi = u_mean + cache_i.rotation * ti;
        Eigen::Vector3d xj = v_mean + cache_j.rotation * tj;

        // Evaluate log p_ij at samples from component i
        auto log_ni_on_i = gauss_log_pdf_diagrot(xi, u_mean, cache_i.rotation_transpose, cache_i.inv_diag, cache_i.log_det);
        auto log_nj_on_i = gauss_log_pdf_diagrot(xi, v_mean, cache_j.rotation_transpose, cache_j.inv_diag, cache_j.log_det);
        sum_log_p_on_i += log_add_exp(log_pi + log_ni_on_i, log_pj + log_nj_on_i);

        // Evaluate log p_ij at samples from component j
        auto log_ni_on_j = gauss_log_pdf_diagrot(xj, u_mean, cache_i.rotation_transpose, cache_i.inv_diag, cache_i.log_det);
        auto log_nj_on_j = gauss_log_pdf_diagrot(xj, v_mean, cache_j.rotation_transpose, cache_j.inv_diag, cache_j.log_det);
        sum_log_p_on_j += log_add_exp(log_pi + log_ni_on_j, log_pj + log_nj_on_j);
    }

    auto ei = sum_log_p_on_i / samples.size();
    auto ej = sum_log_p_on_j / samples.size();
    auto ep_log_p = pi * ei + pj * ej;
    auto geo = ep_log_p + ep_neg_log_q;

    auto c_sh = 0.0;

    for (auto i = 0; i < u.sh.size(); i++) {
        auto d = u.sh[i] - v.sh[i];
        c_sh += (d * d);
    }

    return geo + c_sh;
}

inline static bool validate_gaussian(const splat::Gaussian& gaussian) {
    return gaussian.scale.cwiseGreater(0.0f).all() &&
           gaussian.opacity >= OPACITY_PRUNE_THRESHOLD;
}
} // namespace

namespace splat::lod::detail {
Splat reduce_gaussians(size_t id, const Splat& input, size_t target_count, float scale_boost, size_t max_step) {
    assert(input.gaussians.size() > target_count);

    Splat current;
    uint32_t knn_k = 16;
    auto samples = make_gaussian_samples(1, 0);
    std::vector<uint32_t> out_indices;
    std::vector<float> out_distances;
    std::vector<size_t> order;
    std::vector<std::tuple<uint32_t, uint32_t>> edges;
    std::vector<std::tuple<uint32_t, uint32_t>> pairs;
    std::vector<bool> used;
    std::vector<double> costs;
    std::vector<GaussianCache> caches;
    auto step = 0;

    // prune gaussians
    current.gaussians.reserve(input.gaussians.size());
    helpers::container::append_range(current.gaussians, input.gaussians | std::views::filter(validate_gaussian));

    while (current.gaussians.size() > target_count && current.gaussians.size() > 0 && step < max_step) {
        GaussianCloud cloud(current);
        KDTree tree(3, cloud,
            nanoflann::KDTreeSingleIndexAdaptorParams(
                10, nanoflann::KDTreeSingleIndexAdaptorFlags::None,
                std::max(std::bit_floor(std::thread::hardware_concurrency()) / 2u, 1u)));

        auto k_eff = std::min<uint32_t>(std::max<uint32_t>(1, knn_k), std::max<uint32_t>(1, current.gaussians.size() - 1));
        size_t query_count = static_cast<size_t>(std::min<size_t>(current.gaussians.size(), k_eff + 1));
        auto max_pairs = current.gaussians.size() - target_count;

        assert(max_pairs > 0);

        Splat generated;

        edges.clear();
        edges.reserve(current.gaussians.size() * k_eff);
        caches.clear();
        caches.reserve(current.gaussians.size());
        generated.gaussians.reserve(current.gaussians.size() / 2);

        build_cache(current, caches);

        // knn search
        for (auto i = 0; i < current.gaussians.size(); i++) {
            out_indices.assign(query_count, 0);
            out_distances.assign(query_count, 0.0);
            auto result_count = tree.knnSearch(current.gaussians[i].mean.data(), query_count, out_indices.data(), out_distances.data());
            const size_t take = std::min<size_t>(k_eff, result_count > 0 ? result_count - 1 : size_t { 0 });
            for (auto j = 0; j < take; j++) {
                auto neighbor = static_cast<int>(out_indices[j + 1]);
                if (neighbor <= i) {
                    continue;
                }
                edges.emplace_back(i, neighbor);
            }
        }

        assert(edges.size() > 0);

        // compute edge costs.
        {

            costs.clear();
            costs.reserve(edges.size());
            for (auto& edge : edges) {
                costs.push_back(compute_edge_cost(current, caches, samples, edge));
            }
        }

        // take pairs
        {
            order.clear();
            order.reserve(edges.size());
            for (auto i = 0; i < costs.size(); ++i) {
                if (std::isfinite(costs[i])) {
                    order.push_back(i);
                }
            }

            std::stable_sort(order.begin(), order.end(), [&](const size_t lhs, const size_t rhs) {
                return costs[lhs] < costs[rhs];
            });

            used.assign(current.gaussians.size(), false);
            pairs.clear();
            pairs.reserve(max_pairs);

            for (auto edge_idx : order) {
                const auto [u, v] = edges[edge_idx];
                if (used[u] || used[v]) {
                    continue;
                }
                used[u] = true;
                used[v] = true;
                pairs.emplace_back(u, v);
                if (pairs.size() >= max_pairs) {
                    break;
                }
            }
        }

        // merge pairs
        for (auto& pair : pairs) {
            auto [u, v] = pair;
            auto g = merge_gaussians(current, { u, v }, scale_boost);
            if (validate_gaussian(g)) {
                generated.gaussians.push_back(std::move(g));
            }
        }

        // keep unused gaussian
        for (auto i = 0; i < current.gaussians.size(); i++) {
            if (!used[i]) {
                generated.gaussians.push_back(current.gaussians[i]);
            }
        }

        current = std::move(generated);

        // trace hard working on current block.
        if (step >= max_step / 2) {
            printf("block: %zu, step: %d, required: %zu, current: %zu(%.2f%%)\n",
                id, step, target_count, current.gaussians.size(),
                static_cast<double>(current.gaussians.size()) / static_cast<double>(target_count) * 100.0);
        }

        // cannot reduce any more...
        if (pairs.size() == 0) {
            break;
        }

        step++;
    }
    current.gaussians.shrink_to_fit();
    return current;
}
} // namespace splat::lod::detail
