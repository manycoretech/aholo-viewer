namespace splat_transform::voxel {
template<uint32_t BrickSize>
    requires ValidBrickSize<BrickSize>
BrickMap<BrickSize>::BrickMap(Eigen::Vector3i blocks)
    : blocks_(blocks), dimensions_((blocks.array() + block_side - 1) / block_side),
      directory_(static_cast<size_t>(dimensions_.x()) * dimensions_.y() * dimensions_.z(), EMPTY) {}

template<uint32_t BrickSize>
    requires ValidBrickSize<BrickSize>
Eigen::Vector3i BrickMap<BrickSize>::origin(uint32_t index) const {
    const auto row = index / dimensions_.x();
    return Eigen::Vector3i(index % dimensions_.x(), row % dimensions_.y(), row / dimensions_.y()) * block_side;
}
template<uint32_t BrickSize>
    requires ValidBrickSize<BrickSize>
auto BrickMap<BrickSize>::valid_blocks(Eigen::Vector3i base) const -> BlockBits {
    const Eigen::Vector3i extent = (blocks_ - base).cwiseMin(block_side);
    BlockBits valid;
    if ((extent.array() == block_side).all()) {
        valid.words.fill(FULL_BLOCK);
        if constexpr (block_capacity % 64 != 0) {
            valid.words.back() >>= 64 - block_capacity % 64;
        }
        return valid;
    }
    for (int32_t z = 0; z < extent.z(); ++z) {
        for (int32_t y = 0; y < extent.y(); ++y) {
            for (int32_t x = 0; x < extent.x(); ++x) {
                valid.set(local_index({ x, y, z }), true);
            }
        }
    }
    return valid;
}
template<uint32_t BrickSize>
    requires ValidBrickSize<BrickSize>
auto BrickMap<BrickSize>::classify(const Masks& masks, const BlockBits& valid) -> OccupancyBits {
    OccupancyBits bits;
    for (size_t word = 0; word < valid.words.size(); ++word) {
        uint64_t nonempty = 0, nonfull = 0;
        const size_t start = word * 64;
        const size_t count = std::min<size_t>(64, block_capacity - start);
        for (size_t i = 0; i < count; ++i) {
            const auto mask = masks[start + i];
            // MSVC 19.52 on ARM64 miscompiles shifting both comparison results by i.
            const uint64_t bit = uint64_t { 1 } << i;
            nonempty |= mask != 0 ? bit : 0;
            nonfull |= mask != FULL_BLOCK ? bit : 0;
        }
        bits.nonempty.words[word] = nonempty & valid.words[word];
        bits.nonfull.words[word] = nonfull & valid.words[word];
    }
    return bits;
}
template<uint32_t BrickSize>
    requires ValidBrickSize<BrickSize>
void BrickMap<BrickSize>::set(Eigen::Vector3i block, uint64_t mask) {
    const auto owner = brick_index(block);
    auto& slot = directory_[owner];
    mask ^= background_;
    if (slot >= SOLID) {
        const uint64_t uniform = slot == SOLID ? FULL_BLOCK : 0;
        if (mask == uniform) {
            return;
        }
        const auto valid = valid_blocks(origin(owner));
        auto& brick = pool_.emplace_back();
        brick.owner = owner;
        brick.masks.fill(uniform);
        brick.bits = uniform ? OccupancyBits { valid, {} } : OccupancyBits { {}, valid };
        slot = static_cast<uint32_t>(pool_.size() - 1);
    }
    auto& brick = pool_[slot];
    const auto i = local_index(block);
    brick.masks[i] = mask;
    brick.bits.nonempty.set(i, mask != 0);
    brick.bits.nonfull.set(i, mask != FULL_BLOCK);
    if ((mask == 0 && brick.bits.nonempty.empty()) || (mask == FULL_BLOCK && brick.bits.nonfull.empty())) {
        const auto uniform = mask ? SOLID : EMPTY;
        if (slot != pool_.size() - 1) {
            brick = std::move(pool_.back());
            directory_[brick.owner] = slot;
        }
        pool_.pop_back();
        slot = uniform;
    }
}
template<uint32_t BrickSize>
    requires ValidBrickSize<BrickSize>
bool BrickMap<BrickSize>::empty() const {
    const auto empty_slot = background_ ? SOLID : EMPTY;
    return pool_.empty() && std::ranges::all_of(directory_, [empty_slot](uint32_t slot) { return slot == empty_slot; });
}
template<uint32_t BrickSize>
    requires ValidBrickSize<BrickSize>
size_t BrickMap<BrickSize>::occupied_blocks() const {
    size_t count = 0;
    visit_bricks(0, [&](Eigen::Vector3i, const BlockBits& bits, const Brick*) { count += bits.count(); });
    return count;
}
template<uint32_t BrickSize>
    requires ValidBrickSize<BrickSize>
uint64_t BrickMap<BrickSize>::voxel_count() const {
    uint64_t count = 0;
    visit_bricks(0, [&](Eigen::Vector3i, const BlockBits& bits, const Brick* brick) {
        if (!brick) {
            count += 64 * bits.count();
        } else {
            bits.for_each([&](size_t i) { count += std::popcount(brick->masks[i] ^ background_); });
        }
    });
    return count;
}
template<uint32_t BrickSize>
    requires ValidBrickSize<BrickSize>
bool BrickMap<BrickSize>::operator==(const BrickMap& other) const {
    if (blocks_ != other.blocks_ || occupied_blocks() != other.occupied_blocks()) {
        return false;
    }
    bool equal = true;
    for_each_block(0, [&](Eigen::Vector3i p, uint64_t bits) { equal &= bits == other.get(p); });
    return equal;
}
} // namespace splat_transform::voxel
