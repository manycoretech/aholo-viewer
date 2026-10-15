# A host tool only: no compiler headers or link libraries enter native targets.
set(VCPKG_POLICY_EMPTY_INCLUDE_FOLDER enabled)
set(VCPKG_BUILD_TYPE release)
set(DXC_TAG v1.8.2505.1)
set(DXC_RELEASE 2025_07_14)
set(TOOL_ROOT "${CURRENT_PACKAGES_DIR}/tools/${PORT}")

if(VCPKG_TARGET_IS_WINDOWS)
    vcpkg_download_distfile(ARCHIVE
        URLS "https://github.com/microsoft/DirectXShaderCompiler/releases/download/${DXC_TAG}/dxc_${DXC_RELEASE}.zip"
        FILENAME "dxc_${DXC_RELEASE}.zip"
        SHA512 69dd74ee2bc8a7ac569fa71351209412f74ef901c58dc59d413277e3129ce78d31dbca0996c2910048bfd0575e7a10655d89d361b5a2ed2963c831385711380f)
    vcpkg_extract_source_archive(PACKAGE_PATH ARCHIVE "${ARCHIVE}" NO_REMOVE_ONE_LEVEL)
    file(INSTALL
        "${PACKAGE_PATH}/bin/${VCPKG_TARGET_ARCHITECTURE}/dxc.exe"
        "${PACKAGE_PATH}/bin/${VCPKG_TARGET_ARCHITECTURE}/dxcompiler.dll"
        "${PACKAGE_PATH}/bin/${VCPKG_TARGET_ARCHITECTURE}/dxil.dll"
        DESTINATION "${TOOL_ROOT}/bin")
    vcpkg_install_copyright(FILE_LIST "${PACKAGE_PATH}/LICENSE-MS.txt" "${PACKAGE_PATH}/LICENSE-LLVM.txt")
elseif(VCPKG_TARGET_IS_LINUX AND VCPKG_TARGET_ARCHITECTURE STREQUAL "x64" AND NOT "from-source" IN_LIST FEATURES)
    vcpkg_download_distfile(ARCHIVE
        URLS "https://github.com/microsoft/DirectXShaderCompiler/releases/download/${DXC_TAG}/linux_dxc_${DXC_RELEASE}.x86_64.tar.gz"
        FILENAME "linux_dxc_${DXC_RELEASE}.tar.gz"
        SHA512 4c4138f6720396c71474f3eef96f0d0b510fb612d0183c3b77588c42433889cc0f07fd4549538e9746b4066a2c83de40a6bc9acb7f9bbcd97b7e4ce1a07031ef)
    vcpkg_extract_source_archive(PACKAGE_PATH ARCHIVE "${ARCHIVE}" NO_REMOVE_ONE_LEVEL)
    file(INSTALL "${PACKAGE_PATH}/bin/dxc" DESTINATION "${TOOL_ROOT}/bin" USE_SOURCE_PERMISSIONS)
    # The upstream executable resolves its libraries through $ORIGIN/../lib.
    file(INSTALL "${PACKAGE_PATH}/lib/libdxcompiler.so" "${PACKAGE_PATH}/lib/libdxil.so"
        DESTINATION "${TOOL_ROOT}/lib" USE_SOURCE_PERMISSIONS)
    vcpkg_install_copyright(FILE_LIST "${PACKAGE_PATH}/LICENSE-MS.txt" "${PACKAGE_PATH}/LICENSE-LLVM.txt")
else()
    vcpkg_from_github(OUT_SOURCE_PATH SOURCE_PATH
        REPO microsoft/DirectXShaderCompiler REF "${DXC_TAG}"
        SHA512 e8e6e8cd341f105b5622e833831630e5bc63b9d0154796d47e7a742881601843633cd3e27f4b29c71ccc17be04caf546319d94dfc9bf85de102846fa832901b2
        PATCHES tool-install.patch)
    # These are the submodule revisions recorded by the pinned DXC release.
    vcpkg_from_github(OUT_SOURCE_PATH SPIRV_HEADERS
        REPO KhronosGroup/SPIRV-Headers REF aa6cef192b8e693916eb713e7a9ccadf06062ceb
        SHA512 b68e111dbc57d957d062b4cbbf6ef9e7aa47ac03c68b543fd3d38d71ea333437165339f6e910d930e4e243b18d34eac800bb20b2f739a4fbdd3700f38152f39c)
    vcpkg_from_github(OUT_SOURCE_PATH SPIRV_TOOLS
        REPO KhronosGroup/SPIRV-Tools REF a62abcb402009b9ca5975e6167c09f237f630e0e
        SHA512 e1cadd124b9a2d47119008c1bdf986518b4df36f7dc5136ed0abd3731cd6b9e123efeb5f8d267b243117b89fd107aca14f3a0622920b5a02e45e4d708a9496ad)
    vcpkg_from_github(OUT_SOURCE_PATH DIRECTX_HEADERS
        REPO microsoft/DirectX-Headers REF 980971e835876dc0cde415e8f9bc646e64667bf7
        SHA512 a570068d3c25c68eba34a2653108e2019f888a7392a803f97da9a401713b14bf4235520f0adc37c2f6ffb27cfb118ca7bb0fc8e446b342a7393c9c64afd84ed8)
    vcpkg_cmake_configure(SOURCE_PATH "${SOURCE_PATH}"
        OPTIONS
            "-C${SOURCE_PATH}/cmake/caches/PredefinedParams.cmake"
            "-DDXC_SPIRV_HEADERS_DIR=${SPIRV_HEADERS}"
            "-DDXC_SPIRV_TOOLS_DIR=${SPIRV_TOOLS}"
            "-DDIRECTX_HEADER_INCLUDE_DIR=${DIRECTX_HEADERS}/include"
            -DCMAKE_INSTALL_NAME_DIR=@rpath
            -DCMAKE_POLICY_VERSION_MINIMUM=3.5
            -DENABLE_SPIRV_CODEGEN=ON
            -DHLSL_INCLUDE_TESTS=OFF
            -DHLSL_SUPPORT_QUERY_GIT_COMMIT_INFO=OFF
            -DLLVM_INCLUDE_TESTS=OFF
            -DLLVM_ENABLE_ASSERTIONS=OFF
            -DLLVM_ENABLE_ZLIB=OFF
            -DLLVM_ENABLE_TERMINFO=OFF
            -DSPIRV_BUILD_TESTS=OFF
            -DSPIRV_SKIP_TESTS=ON
            -DSPIRV_WERROR=OFF)
    vcpkg_cmake_build(TARGET install-dxc)
    vcpkg_cmake_build(TARGET install-dxcompiler)
    vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE.TXT" "${SPIRV_TOOLS}/LICENSE"
        "${SPIRV_HEADERS}/LICENSE" "${DIRECTX_HEADERS}/LICENSE")
endif()
