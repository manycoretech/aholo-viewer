cmake_minimum_required(VERSION 3.31)
set(SPLAT_TRANSFORM_PACKAGE_FILE "${CMAKE_CURRENT_SOURCE_DIR}/../../splat-transform/package.json")
file(READ "${SPLAT_TRANSFORM_PACKAGE_FILE}" SPLAT_TRANSFORM_PACKAGE_JSON)
string(JSON SPLAT_TRANSFORM_VERSION GET "${SPLAT_TRANSFORM_PACKAGE_JSON}" version)
string(REGEX MATCH "^[0-9]+\\.[0-9]+\\.[0-9]+" SPLAT_TRANSFORM_PROJECT_VERSION "${SPLAT_TRANSFORM_VERSION}")
if(NOT SPLAT_TRANSFORM_PROJECT_VERSION)
    message(FATAL_ERROR "Invalid splat-transform package version: ${SPLAT_TRANSFORM_VERSION}")
endif()
project(splat_transform VERSION "${SPLAT_TRANSFORM_PROJECT_VERSION}" LANGUAGES C CXX)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${SPLAT_TRANSFORM_PACKAGE_FILE}")
configure_file(src/cli/version.h.in generated/version.h @ONLY)

include(CTest)
include(GNUInstallDirs)
option(SPLAT_TRANSFORM_STATIC_RUNTIME "Link the Linux C++ runtime statically" ON)
option(SPLAT_TRANSFORM_TEST_GPU "Run tests requiring a user-installed Vulkan runtime" OFF)
option(SPLAT_TRANSFORM_TEST_NATIVE_FILE_IO "Require Asio's native file backend in runtime tests" OFF)

find_package(Threads REQUIRED)
find_package(CLI11 CONFIG REQUIRED)
find_package(Boost CONFIG REQUIRED COMPONENTS asio)
find_package(Eigen3 CONFIG REQUIRED)
find_package(nanoflann CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(CURL REQUIRED)
find_package(WebP CONFIG REQUIRED)
find_package(libavif CONFIG REQUIRED)
find_package(ZLIB REQUIRED)
find_package(zstd CONFIG REQUIRED)
find_package(libzip CONFIG REQUIRED)
find_package(VulkanHeaders CONFIG REQUIRED)
find_package(VulkanMemoryAllocator CONFIG REQUIRED)

add_library(splat_transform_core OBJECT)
set(SPLAT_TRANSFORM_SOURCE_FILES
    src/utility/logger.cpp
    src/utility/random.cpp
    src/utility/thread_pool.cpp
    src/splat/splat.cpp
    src/splat/splat_lod.cpp
    src/splat/splat_block.cpp
    src/spatial/clustering.cpp
    src/codec/compression.cpp
    src/codec/image.cpp
    src/io/file.cpp
    src/io/file_stream.cpp
    src/io/stream_reader.cpp
    src/io/resource.cpp
    src/io/ply.cpp
    src/io/spz.cpp
    src/io/format.cpp
    src/io/splat.cpp
    src/io/ksplat.cpp
    src/io/lcc.cpp
    src/io/lcc2.cpp
    src/io/sog.cpp
    src/io/esz.cpp
    src/gpu/compute.cpp
    src/pipeline/runner.cpp
    src/pipeline/task.cpp
    src/pipeline/context.cpp
    src/pipeline/data_support.cpp
    src/pipeline/lod_support.cpp
    src/pipeline/tasks/read.cpp
    src/pipeline/tasks/write.cpp
    src/pipeline/tasks/modify.cpp
    src/pipeline/tasks/select.cpp
    src/pipeline/tasks/replace_append.cpp
    src/pipeline/tasks/extract_lod_level.cpp
    src/pipeline/tasks/skeleton_lod.cpp
    src/pipeline/tasks/flex_lod.cpp
    src/pipeline/tasks/auto_lod.cpp
    src/pipeline/tasks/auto_chunk_lod.cpp
    src/pipeline/tasks/split_splat.cpp
    src/pipeline/tasks/voxel.cpp
    src/pipeline/modify.cpp
    src/voxel/voxel.cpp
    src/voxel/grid.cpp
    src/voxel/voxelize.cpp
    src/voxel/backend.cpp
    src/voxel/backend_cpu.cpp
    src/voxel/backend_gpu.cpp
    src/voxel/mesh.cpp
    src/voxel/marching_cubes.cpp
    src/voxel/coplanar_merge.cpp
)
set(SPLAT_TRANSFORM_HEADER_FILES
    include/codec/codec.h
    include/codec/quantization.h
    include/gpu/compute.h
    include/io/esz.h
    include/io/file.h
    include/io/ksplat.h
    include/io/lcc.h
    include/io/lcc2.h
    include/io/ply.h
    include/io/resource.h
    include/io/sog.h
    include/io/splat.h
    include/io/spz.h
    include/pipeline/context.h
    include/pipeline/runner.h
    include/pipeline/task.h
    include/pipeline/tasks/auto_chunk_lod.h
    include/pipeline/tasks/auto_lod.h
    include/pipeline/tasks/extract_lod_level.h
    include/pipeline/tasks/flex_lod.h
    include/pipeline/tasks/modify.h
    include/pipeline/tasks/read.h
    include/pipeline/tasks/replace_append.h
    include/pipeline/tasks/select.h
    include/pipeline/tasks/skeleton_lod.h
    include/pipeline/tasks/split_splat.h
    include/pipeline/tasks/voxel.h
    include/pipeline/tasks/write.h
    include/spatial/clustering.h
    include/spatial/features.h
    include/spatial/sh_rotation.h
    include/splat/attribute_view.h
    include/splat/splat.h
    include/splat/splat_block.h
    include/splat/splat_lod.h
    include/utility/logger.h
    include/utility/random.h
    include/utility/thread_pool.h
    include/voxel/voxel.h
)
set(SPLAT_TRANSFORM_PRIVATE_HEADER_FILES
    src/codec/compression_stream.h
    src/gpu/cluster_schedule.h
    src/io/zip_archive.h
    src/io/file_stream.h
    src/io/stream_reader.h
    src/pipeline/data_support.h
    src/pipeline/lod_support.h
    src/voxel/grid.h
    src/voxel/backend.h
    src/voxel/marching_tables.h
    src/voxel/voxelize.h
)
list(TRANSFORM SPLAT_TRANSFORM_SOURCE_FILES PREPEND "${CMAKE_CURRENT_SOURCE_DIR}/")
list(TRANSFORM SPLAT_TRANSFORM_HEADER_FILES PREPEND "${CMAKE_CURRENT_SOURCE_DIR}/")
list(TRANSFORM SPLAT_TRANSFORM_PRIVATE_HEADER_FILES PREPEND "${CMAKE_CURRENT_SOURCE_DIR}/")
target_sources(splat_transform_core
    PRIVATE ${SPLAT_TRANSFORM_SOURCE_FILES}
    PUBLIC FILE_SET core_headers
        TYPE HEADERS
        BASE_DIRS "${CMAKE_CURRENT_SOURCE_DIR}/include"
        FILES ${SPLAT_TRANSFORM_HEADER_FILES}
    PRIVATE FILE_SET core_private_headers
        TYPE HEADERS
        BASE_DIRS "${CMAKE_CURRENT_SOURCE_DIR}/src"
        FILES ${SPLAT_TRANSFORM_PRIVATE_HEADER_FILES}
)
source_group(TREE "${CMAKE_CURRENT_SOURCE_DIR}"
    FILES ${SPLAT_TRANSFORM_SOURCE_FILES} ${SPLAT_TRANSFORM_HEADER_FILES} ${SPLAT_TRANSFORM_PRIVATE_HEADER_FILES})

# libc++ currently exposes <syncstream> through its experimental library flag.
set_source_files_properties(src/utility/logger.cpp PROPERTIES
    COMPILE_OPTIONS "$<$<CXX_COMPILER_ID:AppleClang>:-fexperimental-library>"
)
target_link_libraries(splat_transform_core
    PUBLIC Eigen3::Eigen nlohmann_json::nlohmann_json Threads::Threads
    PRIVATE nanoflann::nanoflann WebP::webp avif ZLIB::ZLIB zstd::libzstd
        libzip::zip Vulkan::Headers GPUOpen::VulkanMemoryAllocator ${CMAKE_DL_LIBS} CURL::libcurl Boost::asio
)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    find_path(URING_INCLUDE_DIR liburing.h REQUIRED)
    find_library(URING_LIBRARY uring REQUIRED)
    target_include_directories(splat_transform_core PRIVATE "${URING_INCLUDE_DIR}")
    target_link_libraries(splat_transform_core PRIVATE "${URING_LIBRARY}")
endif()
# Clang's AArch64 SME code needs builtins absent from GCC 12's runtime.
# Keep the GCC unwinder used by libstdc++, including when linked statically.
target_link_options(splat_transform_core INTERFACE
    "$<$<AND:$<PLATFORM_ID:Linux>,$<CXX_COMPILER_ID:Clang>>:--rtlib=compiler-rt;--unwindlib=libgcc>"
)
set_target_properties(splat_transform_core PROPERTIES
    COMPILE_DEFINITIONS "VK_NO_PROTOTYPES;VMA_STATIC_VULKAN_FUNCTIONS=0;VMA_DYNAMIC_VULKAN_FUNCTIONS=1;$<$<PLATFORM_ID:Windows>:NOMINMAX;WIN32_LEAN_AND_MEAN;UNICODE;_UNICODE>"
    INTERFACE_COMPILE_FEATURES cxx_std_20
    INTERFACE_COMPILE_DEFINITIONS "$<$<PLATFORM_ID:Windows>:NOMINMAX;WIN32_LEAN_AND_MEAN;UNICODE;_UNICODE>"
)
target_compile_definitions(splat_transform_core
    PUBLIC "$<$<PLATFORM_ID:Windows>:_WIN32_WINNT=0x0A00;WINVER=0x0A00>"
    PRIVATE "$<$<PLATFORM_ID:Linux>:BOOST_ASIO_HAS_IO_URING>"
)

add_executable(splat-transform)
target_sources(splat-transform PRIVATE
    src/cli/main.cpp
    "$<$<CXX_COMPILER_ID:MSVC>:${CMAKE_CURRENT_SOURCE_DIR}/src/cli/app.manifest>"
    PRIVATE FILE_SET cli_generated_headers
        TYPE HEADERS
        BASE_DIRS "${CMAKE_CURRENT_BINARY_DIR}/generated"
        FILES "${CMAKE_CURRENT_BINARY_DIR}/generated/version.h"
)
source_group(TREE "${CMAKE_CURRENT_SOURCE_DIR}" FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/src/cli/main.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/cli/app.manifest"
)
source_group("generated" FILES "${CMAKE_CURRENT_BINARY_DIR}/generated/version.h")
target_link_libraries(splat-transform PRIVATE splat_transform_core CLI11::CLI11)
set_target_properties(splat-transform PROPERTIES
    LINK_OPTIONS "$<$<PLATFORM_ID:Linux>:-Wl,--exclude-libs,ALL>;$<$<AND:$<PLATFORM_ID:Linux>,$<BOOL:${SPLAT_TRANSFORM_STATIC_RUNTIME}>>:-static-libstdc++;-static-libgcc>"
)
set(SPLAT_TRANSFORM_TARGETS splat_transform_core splat-transform)

include(cmake/shaders.cmake)
install(TARGETS splat-transform RUNTIME DESTINATION .)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../../splat-transform/THIRD_PARTY_LICENSES.txt" DESTINATION .)

find_program(CLANG_FORMAT NAMES clang-format-21 clang-format)
if(CLANG_FORMAT)
    file(GLOB_RECURSE PROJECT_CPP_FILES CONFIGURE_DEPENDS include/*.h src/*.cpp src/*.h tests/*.cpp shaders/*.hlsl shaders/*.hlsli)
    add_custom_target(format COMMAND "${CLANG_FORMAT}" --style=file -i ${PROJECT_CPP_FILES} VERBATIM)
    add_custom_target(check-format COMMAND "${CLANG_FORMAT}" --style=file --dry-run --Werror ${PROJECT_CPP_FILES} VERBATIM)
endif()

if(BUILD_TESTING)
    add_executable(splat_transform_voxel_cpu_tests)
    target_sources(splat_transform_voxel_cpu_tests PRIVATE tests/voxel_cpu_tests.cpp)
    target_include_directories(splat_transform_voxel_cpu_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
    target_link_libraries(splat_transform_voxel_cpu_tests PRIVATE splat_transform_core)
    add_test(NAME voxel_cpu_contracts COMMAND splat_transform_voxel_cpu_tests)
    set_tests_properties(voxel_cpu_contracts PROPERTIES
        TIMEOUT 60
        ENVIRONMENT "VK_DRIVER_FILES=${CMAKE_CURRENT_BINARY_DIR}/missing-vulkan-driver.json;VK_ICD_FILENAMES=${CMAKE_CURRENT_BINARY_DIR}/missing-vulkan-driver.json"
        FAIL_REGULAR_EXPRESSION "Vulkan dilation failed;initialize GPU adapter"
    )
    add_executable(splat_transform_streaming_tests)
    target_sources(splat_transform_streaming_tests PRIVATE tests/streaming_tests.cpp)
    target_include_directories(splat_transform_streaming_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
    target_link_libraries(splat_transform_streaming_tests PRIVATE splat_transform_core)
    add_test(NAME streaming_contracts COMMAND splat_transform_streaming_tests)
    if(SPLAT_TRANSFORM_TEST_NATIVE_FILE_IO)
        add_test(NAME native_file_io COMMAND splat_transform_streaming_tests --require-native-file-io)
    endif()
    add_executable(splat_transform_logging_tests)
    target_sources(splat_transform_logging_tests PRIVATE tests/logging_tests.cpp)
    target_link_libraries(splat_transform_logging_tests PRIVATE splat_transform_core)
    add_test(NAME logging_contracts COMMAND splat_transform_logging_tests)
    add_executable(splat_transform_abstraction_tests)
    target_sources(splat_transform_abstraction_tests PRIVATE tests/abstraction_tests.cpp)
    target_link_libraries(splat_transform_abstraction_tests PRIVATE splat_transform_core)
    add_test(NAME abstraction_contracts COMMAND splat_transform_abstraction_tests)
    add_executable(splat_transform_geometry_tests)
    target_sources(splat_transform_geometry_tests PRIVATE tests/geometry_tests.cpp)
    target_include_directories(splat_transform_geometry_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
    target_link_libraries(splat_transform_geometry_tests PRIVATE splat_transform_core)
    add_test(NAME geometry_contracts COMMAND splat_transform_geometry_tests)
    add_executable(splat_transform_tests)
    target_sources(splat_transform_tests PRIVATE tests/core_tests.cpp)
    set_target_properties(splat_transform_tests PROPERTIES INCLUDE_DIRECTORIES "${CMAKE_CURRENT_SOURCE_DIR}/src")
    target_link_libraries(splat_transform_tests PRIVATE splat_transform_core)
    add_test(NAME core COMMAND splat_transform_tests)
    add_executable(splat_transform_pipeline_tests)
    target_sources(splat_transform_pipeline_tests PRIVATE tests/pipeline_tests.cpp)
    set_target_properties(splat_transform_pipeline_tests PROPERTIES INCLUDE_DIRECTORIES "${CMAKE_CURRENT_SOURCE_DIR}/src")
    target_link_libraries(splat_transform_pipeline_tests PRIVATE splat_transform_core)
    add_test(NAME pipeline_contracts COMMAND splat_transform_pipeline_tests)
    add_executable(splat_transform_data_task_tests)
    target_sources(splat_transform_data_task_tests PRIVATE tests/data_task_tests.cpp)
    target_link_libraries(splat_transform_data_task_tests PRIVATE splat_transform_core)
    add_test(NAME data_task_contracts COMMAND splat_transform_data_task_tests)
    add_executable(splat_transform_frozen_pipeline_tests)
    target_sources(splat_transform_frozen_pipeline_tests PRIVATE tests/frozen_pipeline_tests.cpp)
    target_link_libraries(splat_transform_frozen_pipeline_tests PRIVATE splat_transform_core)
    add_test(NAME frozen_pipeline_contracts COMMAND splat_transform_frozen_pipeline_tests "${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/pipeline-v1")
    add_executable(splat_transform_threading_tests)
    target_sources(splat_transform_threading_tests PRIVATE tests/threading_tests.cpp)
    target_link_libraries(splat_transform_threading_tests PRIVATE splat_transform_core)
    add_test(NAME threading_contracts COMMAND splat_transform_threading_tests)
    set_tests_properties(threading_contracts PROPERTIES TIMEOUT 30)
    add_executable(splat_transform_shader_tests)
    target_sources(splat_transform_shader_tests PRIVATE tests/shader_tests.cpp)
    target_include_directories(splat_transform_shader_tests PRIVATE "${SHADER_OUTPUT_DIR}")
    target_link_libraries(splat_transform_shader_tests PRIVATE splat_transform_core)
    add_test(NAME shader_contracts COMMAND splat_transform_shader_tests)
    add_executable(splat_transform_gpu_tests)
    target_sources(splat_transform_gpu_tests PRIVATE tests/gpu_tests.cpp)
    set_target_properties(splat_transform_gpu_tests PROPERTIES INCLUDE_DIRECTORIES "${CMAKE_CURRENT_SOURCE_DIR}/src")
    target_link_libraries(splat_transform_gpu_tests PRIVATE splat_transform_core)
    if(SPLAT_TRANSFORM_TEST_GPU)
        add_test(NAME gpu_contracts COMMAND splat_transform_gpu_tests)
    endif()
    add_test(NAME pipeline_empty COMMAND splat-transform "${CMAKE_CURRENT_SOURCE_DIR}/tests/empty.json")
    if(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND SPLAT_TRANSFORM_STATIC_RUNTIME)
        add_test(NAME linux_abi COMMAND "${CMAKE_COMMAND}" "-DEXECUTABLE=$<TARGET_FILE:splat-transform>" -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/check_linux_abi.cmake")
    endif()
    list(APPEND SPLAT_TRANSFORM_TARGETS
        splat_transform_voxel_cpu_tests
        splat_transform_streaming_tests
        splat_transform_logging_tests
        splat_transform_abstraction_tests splat_transform_geometry_tests splat_transform_tests splat_transform_pipeline_tests
        splat_transform_data_task_tests
        splat_transform_frozen_pipeline_tests
        splat_transform_threading_tests splat_transform_shader_tests splat_transform_gpu_tests)
endif()

set_target_properties(${SPLAT_TRANSFORM_TARGETS} PROPERTIES
    COMPILE_FEATURES cxx_std_20
    CXX_EXTENSIONS OFF
    # Native sources use C++20 without importing C++ modules.
    CXX_SCAN_FOR_MODULES OFF
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
    COMPILE_OPTIONS "$<$<CXX_COMPILER_ID:MSVC>:/Zc:__cplusplus;/utf-8>"
)
