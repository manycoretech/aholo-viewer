#pragma once
#include <Eigen/Core>
#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>
#include <limits>
#include <utility/parallel.h>
#include <vector>

namespace splat_transform::voxel {
inline constexpr uint64_t FULL_BLOCK = std::numeric_limits<uint64_t>::max();

template<uint32_t BrickSize>
concept ValidBrickSize = BrickSize >= 4 && BrickSize % 4 == 0;

// BrickSize is the side length in voxels. Coordinates address 4³-voxel blocks.
template<uint32_t BrickSize = 16>
    requires ValidBrickSize<BrickSize>
class BrickMap {
public:
    static constexpr uint32_t voxel_side = BrickSize;
    static constexpr int32_t block_side = BrickSize / 4;
    static constexpr size_t block_capacity = static_cast<size_t>(block_side) * block_side * block_side;
    using Masks = std::array<uint64_t, block_capacity>;
    explicit BrickMap(Eigen::Vector3i blocks = Eigen::Vector3i::Zero());

    uint32_t brick_index(Eigen::Vector3i block) const {
        const auto x = static_cast<uint32_t>(block.x()) / block_side;
        const auto y = static_cast<uint32_t>(block.y()) / block_side;
        const auto z = static_cast<uint32_t>(block.z()) / block_side;
        return x + this->dimensions_.x() * (y + this->dimensions_.y() * z);
    }
    uint64_t get(Eigen::Vector3i block) const {
        const auto slot = this->directory_[this->brick_index(block)];
        const auto bits = slot == EMPTY ? uint64_t { 0 } : slot == SOLID ? FULL_BLOCK
                                                                         : this->pool_[slot].masks[local_index(block)];
        return bits ^ this->background_;
    }
    void set(Eigen::Vector3i block, uint64_t mask);
    uint64_t background() const { return this->background_; }
    void invert() { this->background_ = ~this->background_; }
    bool empty() const;
    size_t occupied_blocks() const;
    uint64_t voxel_count() const;
    bool operator==(const BrickMap& other) const;

    // Each source brick has a unique directory index. Classify first so the
    // final pool is allocated once and workers can write disjoint bricks.
    template<typename IndexAt, typename MasksAt>
    void assign_bricks(size_t count, IndexAt index_at, MasksAt masks_at) {
        struct Entry {
            uint32_t index, slot;
            OccupancyBits bits;
        };
        std::vector<Entry> entries(count);
        threading::parallel_chunks(count, 256, [&](size_t begin, size_t end) {
            for (size_t i = begin; i < end; ++i) {
                auto& entry = entries[i];
                entry.index = index_at(i);
                entry.bits = classify(masks_at(i), this->valid_blocks(this->origin(entry.index)));
            }
        });
        uint32_t mixed = 0;
        for (auto& entry : entries) {
            entry.slot = entry.bits.nonempty.empty() ? EMPTY : entry.bits.nonfull.empty() ? SOLID
                                                                                          : mixed++;
        }
        std::vector<Brick> pool(mixed);
        threading::parallel_chunks(count, 256, [&](size_t begin, size_t end) {
            for (size_t i = begin; i < end; ++i) {
                const auto& entry = entries[i];
                if (entry.slot < SOLID) {
                    pool[entry.slot] = { masks_at(i), entry.bits, entry.index };
                }
            }
        });
        std::fill(this->directory_.begin(), this->directory_.end(), EMPTY);
        for (const auto& entry : entries) {
            this->directory_[entry.index] = entry.slot;
        }
        this->pool_ = std::move(pool);
        this->background_ = 0;
    }

    // Skip either empty or fully occupied blocks. Order within and between
    // bricks is spatial; callers needing linear block order sort explicitly.
    template<typename F>
    void for_each_block(uint64_t skip, F&& visit) const {
        this->visit_bricks(skip, [&](Eigen::Vector3i base, const BlockBits& bits, const Brick* brick) {
            bits.for_each([&](size_t i) {
                const Eigen::Vector3i local { static_cast<int32_t>(i % block_side),
                    static_cast<int32_t>((i / block_side) % block_side), static_cast<int32_t>(i / block_side / block_side) };
                visit(base + local, brick ? brick->masks[i] ^ this->background_ : ~skip);
            });
        });
    }

private:
    static constexpr uint32_t EMPTY = std::numeric_limits<uint32_t>::max();
    static constexpr uint32_t SOLID = EMPTY - 1;
    struct BlockBits {
        std::array<uint64_t, (block_capacity + 63) / 64> words {};
        void set(size_t i, bool value) {
            const uint64_t bit = uint64_t { 1 } << (i % 64);
            auto& word = this->words[i / 64];
            word = value ? word | bit : word & ~bit;
        }
        bool empty() const {
            return std::ranges::all_of(this->words, [](uint64_t word) { return word == 0; });
        }
        size_t count() const {
            size_t total = 0;
            for (auto word : this->words) {
                total += std::popcount(word);
            }
            return total;
        }
        template<typename F>
        void for_each(F&& visit) const {
            for (size_t i = 0; i < this->words.size(); ++i) {
                for (auto bits = this->words[i]; bits; bits &= bits - 1) {
                    visit(i * 64 + std::countr_zero(bits));
                }
            }
        }
    };
    struct OccupancyBits {
        BlockBits nonempty, nonfull; // Padded slots belong to neither set.
    };
    struct Brick {
        Masks masks;
        OccupancyBits bits;
        uint32_t owner;
    };
    static size_t local_index(Eigen::Vector3i p) {
        const auto x = static_cast<uint32_t>(p.x()) % block_side;
        const auto y = static_cast<uint32_t>(p.y()) % block_side;
        const auto z = static_cast<uint32_t>(p.z()) % block_side;
        return x + static_cast<size_t>(block_side) * (y + static_cast<size_t>(block_side) * z);
    }
    Eigen::Vector3i origin(uint32_t index) const;
    BlockBits valid_blocks(Eigen::Vector3i origin) const;
    static OccupancyBits classify(const Masks& masks, const BlockBits& valid);

    template<typename F>
    void visit_bricks(uint64_t skip, F&& visit) const {
        const bool skip_solid = (skip ^ this->background_) == FULL_BLOCK;
        const auto skipped = skip_solid ? SOLID : EMPTY;
        for (uint32_t i = 0; i < this->directory_.size(); ++i) {
            const auto slot = this->directory_[i];
            if (slot != skipped) {
                const auto base = this->origin(i);
                const auto* brick = slot < SOLID ? &this->pool_[slot] : nullptr;
                if (brick) {
                    visit(base, skip_solid ? brick->bits.nonfull : brick->bits.nonempty, brick);
                } else {
                    visit(base, this->valid_blocks(base), nullptr);
                }
            }
        }
    }
    Eigen::Vector3i blocks_, dimensions_;
    std::vector<uint32_t> directory_;
    std::vector<Brick> pool_;
    uint64_t background_ = 0;
};
} // namespace splat_transform::voxel

#include "brick_map.inl"
