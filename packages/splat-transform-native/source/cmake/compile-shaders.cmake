cmake_minimum_required(VERSION 3.31)
include("${CMAKE_CURRENT_LIST_DIR}/shader-inputs.cmake")

if(NOT DEFINED DXC_EXECUTABLE OR DXC_EXECUTABLE STREQUAL "")
    if(DEFINED ENV{DXC_EXECUTABLE} AND NOT "$ENV{DXC_EXECUTABLE}" STREQUAL "")
        set(DXC_EXECUTABLE "$ENV{DXC_EXECUTABLE}")
    else()
        set(DXC_EXECUTABLE dxc)
    endif()
endif()
find_program(SHADER_DXC NAMES "${DXC_EXECUTABLE}" NO_CACHE)
if(NOT SHADER_DXC)
    message(FATAL_ERROR
        "DXC was not found. Install a SPIR-V-enabled DXC and put it on PATH, set DXC_EXECUTABLE, or pass -DDXC_EXECUTABLE=/path/to/dxc before -P.")
endif()
if(NOT COMPUTE_SHADERS OR NOT EXISTS "${SHADER_DIRECTORY}/cluster.hlsl")
    message(FATAL_ERROR "Expected HLSL shaders, including cluster.hlsl, in ${SHADER_DIRECTORY}")
endif()

set(SHADER_TEMP_ROOT "${SHADER_OUTPUT_DIR}")
string(RANDOM LENGTH 16 ALPHABET 0123456789abcdef SHADER_TEMP_ID)
set(SHADER_TEMP_DIRECTORY "${SHADER_TEMP_ROOT}/.shader-compile-${SHADER_TEMP_ID}")
file(MAKE_DIRECTORY "${SHADER_TEMP_DIRECTORY}")

function(clean_shader_temp)
    cmake_path(IS_PREFIX SHADER_TEMP_ROOT "${SHADER_TEMP_DIRECTORY}" NORMALIZE IS_TEMP_CHILD)
    if(NOT IS_TEMP_CHILD OR SHADER_TEMP_DIRECTORY STREQUAL SHADER_TEMP_ROOT)
        message(FATAL_ERROR "Refusing to remove a directory outside the shader build directory.")
    endif()
    file(REMOVE_RECURSE "${SHADER_TEMP_DIRECTORY}")
endfunction()

function(compile_shader NAME SOURCE)
    message(STATUS "Compiling ${NAME}")
    set(BINARY "${SHADER_TEMP_DIRECTORY}/${NAME}.spv")
    execute_process(
        COMMAND "${SHADER_DXC}" ${SHADER_DXC_OPTIONS} ${ARGN} -Fo "${BINARY}" "${SOURCE}"
        RESULT_VARIABLE DXC_RESULT)
    if(NOT DXC_RESULT STREQUAL "0")
        clean_shader_temp()
        message(FATAL_ERROR "DXC failed for ${NAME}: ${DXC_RESULT}")
    endif()
    file(READ "${BINARY}" SHADER_HEX HEX)
    string(REGEX REPLACE "(..)" "0x\\1," SHADER_BYTES "${SHADER_HEX}")
    file(CONFIGURE OUTPUT "${SHADER_TEMP_DIRECTORY}/${NAME}.h"
        CONTENT "#pragma once\n#include <cstdint>\nnamespace splat_transform::gpu::vulkan::shaders {\nalignas(4) inline constexpr uint8_t ${NAME}[] = { ${SHADER_BYTES} };\n}\n"
        @ONLY NEWLINE_STYLE UNIX)
endfunction()

foreach(SHADER IN LISTS COMPUTE_SHADERS)
    get_filename_component(NAME "${SHADER}" NAME_WE)
    if(NOT NAME STREQUAL "cluster")
        compile_shader("${NAME}" "${SHADER}")
    endif()
endforeach()

set(CLUSTER_HEADER "// shader-input-sha256: ${SHADER_INPUT_HASH}\n#pragma once\n#include <array>\n#include <cstdint>\n#include <span>\n#include <string_view>\n")
set(CLUSTER_VARIANTS "")
foreach(COLUMNS IN LISTS SHADER_CLUSTER_COLUMNS)
    foreach(TILE IN LISTS SHADER_CLUSTER_TILES)
        set(NAME "cluster_${COLUMNS}_${TILE}")
        compile_shader("${NAME}" "${SHADER_DIRECTORY}/cluster.hlsl"
            "-DVEC_COLUMNS=${COLUMNS}" "-DTILE_SIZE=${TILE}")
        string(APPEND CLUSTER_HEADER "#include \"${NAME}.h\"\n")
        string(APPEND CLUSTER_VARIANTS "    ClusterShader { \"${NAME}\", ${COLUMNS}, ${TILE}, ${NAME} },\n")
    endforeach()
endforeach()
string(APPEND CLUSTER_HEADER "namespace splat_transform::gpu::vulkan::shaders {\nstruct ClusterShader {\n    std::string_view name;\n    uint32_t columns;\n    uint32_t tile;\n    std::span<const uint8_t> spirv;\n};\ninline constexpr std::array cluster_variants {\n${CLUSTER_VARIANTS}};\n}\n")
file(CONFIGURE OUTPUT "${SHADER_TEMP_DIRECTORY}/cluster.h" CONTENT "${CLUSTER_HEADER}"
    @ONLY NEWLINE_STYLE UNIX)

# Publish only after every compilation succeeds; write the input stamp last.
# Unchanged headers retain their timestamps to avoid unnecessary native builds.
foreach(HEADER IN LISTS GENERATED_SHADER_HEADERS)
    get_filename_component(NAME "${HEADER}" NAME)
    if(NOT NAME STREQUAL "cluster.h")
        file(COPY_FILE "${SHADER_TEMP_DIRECTORY}/${NAME}" "${HEADER}" ONLY_IF_DIFFERENT)
    endif()
endforeach()
file(COPY_FILE "${SHADER_TEMP_DIRECTORY}/cluster.h" "${SHADER_OUTPUT_DIR}/cluster.h" ONLY_IF_DIFFERENT)
clean_shader_temp()
list(LENGTH GENERATED_SHADER_HEADERS HEADER_COUNT)
message(STATUS "Generated ${HEADER_COUNT} headers in ${SHADER_OUTPUT_DIR}")
