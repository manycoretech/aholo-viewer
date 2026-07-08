cmake_minimum_required(VERSION 3.31)
cmake_policy(SET CMP0091 NEW)
cmake_policy(SET CMP0042 NEW)

project(binding)

find_package(Threads REQUIRED)
find_package(Eigen3 CONFIG REQUIRED)
find_package(nanoflann CONFIG REQUIRED)
find_package(cmake-js CONFIG REQUIRED)
find_package(WebP CONFIG REQUIRED)
find_package(libavif CONFIG REQUIRED)

set(BINDING_BINARY_DIR "${CMAKE_CURRENT_BINARY_DIR}" CACHE PATH "node binding output dir")

add_library(${PROJECT_NAME} SHARED)
list(APPEND BINDING_SOURCE_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/src/thread_pool.cpp"
    # GAUSSIAN SPLAT
    "${CMAKE_CURRENT_SOURCE_DIR}/src/splat/splat.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/splat/splat_lod.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/splat/splat_block.cpp"
    # NODE API FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/src/node/api_splat.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/node/api_spatial.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/node/api_thread_pool.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/node/api_webp.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/node/api_avif.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/node/binding.cpp"
)
list(APPEND BINDING_HEADER_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/include/future_helpers.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/container_helpers.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/thread_pool.h"
    # GAUSSIAN SPLAT
    "${CMAKE_CURRENT_SOURCE_DIR}/include/splat/splat.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/splat/splat_lod.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/splat/splat_block.h"
    # NODE API FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/include/node/api_buffer.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/node/api_splat.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/node/api_spatial.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/node/api_thread_pool.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/node/api_webp.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/include/node/api_avif.h"
)
target_sources(${PROJECT_NAME}
PRIVATE
    ${BINDING_SOURCE_FILES}

PRIVATE FILE_SET binding_private_headers
    TYPE HEADERS
    BASE_DIRS "${CMAKE_CURRENT_SOURCE_DIR}/include"
    FILES ${BINDING_HEADER_FILES}
)
target_link_libraries(${PROJECT_NAME}
    PRIVATE cmake_js::node Threads::Threads Eigen3::Eigen nanoflann::nanoflann WebP::webp avif
)
set_target_properties(
    ${PROJECT_NAME} PROPERTIES
    PREFIX ""
    OUTPUT_NAME "splat-transform"
    SUFFIX ".node"
    CXX_EXTENSIONS OFF
    COMPILE_FEATURES cxx_std_20
    COMPILE_OPTIONS $<$<CXX_COMPILER_ID:MSVC>:/Zc:__cplusplus>
    LINK_OPTIONS $<$<AND:$<CXX_COMPILER_ID:GNU,Clang>,$<NOT:$<PLATFORM_ID:Apple>>>:-Wl,--exclude-libs,ALL>
    COMPILE_DEFINITIONS "UNICODE;_UNICODE"
    INTERPROCEDURAL_OPTIMIZATION ON
    LIBRARY_OUTPUT_DIRECTORY ${BINDING_BINARY_DIR}
    RUNTIME_OUTPUT_DIRECTORY ${BINDING_BINARY_DIR}
    RUNTIME_OUTPUT_DIRECTORY_RELEASE ${BINDING_BINARY_DIR}
    LIBRARY_OUTPUT_DIRECTORY_RELEASE ${BINDING_BINARY_DIR}
)
