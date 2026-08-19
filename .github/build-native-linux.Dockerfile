# Linux build environment pinned to Ubuntu 22.04 (glibc 2.35 / libstdc++ 12).
# The GitHub runner itself now runs Ubuntu 26.04, but building inside this
# image keeps splat-transform native binaries runnable on the documented
# glibc >= 2.34 baseline instead of adopting the newer runner glibc.
#
# Toolchain versions are build args and can be overridden from outside:
#   docker build \
#     --build-arg CMAKE_VERSION=4.4.2 \
#     --build-arg NINJA_VERSION=1.13.2 \
#     --build-arg NODE_VERSION=24 \
#     -t aholo-native-linux:22.04 \
#     -f .github/build-native-linux.Dockerfile .github

FROM ubuntu:22.04

ARG TARGETARCH
ARG CMAKE_VERSION=4.4.2
ARG NINJA_VERSION=1.13.2
ARG NODE_VERSION=24

ENV DEBIAN_FRONTEND=noninteractive

# Build prerequisites. g++-12 is jammy's newest GCC and matches the old
# ubuntu-22.04 runner, so clang-21 keeps the same GLIBCXX_3.4.30 ceiling.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl g++-12 git gnupg lsb-release \
        nasm perl pkg-config python3 python-is-python3 software-properties-common \
        unzip wget xz-utils zip \
    && rm -rf /var/lib/apt/lists/*

# clang-21 from the official apt.llvm.org script, same as the old runner setup.
RUN wget -qO /tmp/llvm.sh https://apt.llvm.org/llvm.sh \
    && chmod +x /tmp/llvm.sh \
    && /tmp/llvm.sh 21 \
    && rm /tmp/llvm.sh \
    && update-alternatives --install /usr/bin/clang clang /usr/bin/clang-21 20 \
    && update-alternatives --install /usr/bin/clang++ clang++ /usr/bin/clang++-21 20 \
    && update-alternatives --install /usr/bin/cc cc /usr/bin/clang-21 20 \
    && update-alternatives --install /usr/bin/c++ c++ /usr/bin/clang++-21 20 \
    && update-alternatives --set clang /usr/bin/clang-21 \
    && update-alternatives --set clang++ /usr/bin/clang++-21 \
    && update-alternatives --set cc /usr/bin/clang-21 \
    && update-alternatives --set c++ /usr/bin/clang++-21

# CMake from the official Kitware release binaries.
# Docker's TARGETARCH is amd64/arm64; Kitware's assets use x86_64/aarch64.
RUN case "${TARGETARCH}" in \
        amd64) cmake_arch=x86_64 ;; \
        arm64) cmake_arch=aarch64 ;; \
        *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-${cmake_arch}.tar.gz" \
        | tar -xz --strip-components=1 -C /usr/local

# Ninja from the official release binaries. The presets pin /usr/bin/ninja,
# and CMake 4.x wants Ninja >= 1.11, so install 1.13+ there directly.
RUN case "${TARGETARCH}" in \
        amd64) ninja_archive=ninja-linux.zip ;; \
        arm64) ninja_archive=ninja-linux-aarch64.zip ;; \
        *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/ninja-build/ninja/releases/download/v${NINJA_VERSION}/${ninja_archive}" \
        -o /tmp/ninja.zip \
    && unzip -o /tmp/ninja.zip -d /usr/bin \
    && chmod +x /usr/bin/ninja \
    && rm /tmp/ninja.zip

# Node.js is resolved through fnm from the NODE_VERSION build arg. The
# workflow passes env.NODE_VERSION (for example "24"), so the image and the
# host runners share one version source without pinning a patch release here.
# pnpm is intentionally not baked into the image: the build step enables
# corepack and installs the workspace-pinned pnpm on demand.
RUN curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
ENV FNM_DIR=/root/.local/share/fnm \
    PATH="/root/.local/share/fnm:${PATH}"
RUN fnm install "${NODE_VERSION}"
ENV PATH="/root/.local/share/fnm/aliases/default/bin:${PATH}"

# vcpkg tool + toolchain bootstrapped on the pinned 22.04 base, so vcpkg-built
# dependencies also keep the Ubuntu 22.04 glibc requirement.
RUN git clone --depth 1 https://github.com/microsoft/vcpkg /opt/vcpkg \
    && /opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics

ENV VCPKG_ROOT=/opt/vcpkg
ENV PATH="/opt/vcpkg:${PATH}"
