find_program(DXC_EXECUTABLE NAMES dxc
    HINTS "${VCPKG_INSTALLED_DIR}/${VCPKG_HOST_TRIPLET}/tools/dxc/bin"
    REQUIRED)
file(GLOB COMPUTE_SHADERS CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/shaders/*.hlsl")
file(GLOB SHADER_INCLUDES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/shaders/*.hlsli")
set(GENERATED_SHADER_HEADERS)

function(compile_compute_shader SHADER_NAME SHADER)
    set(SHADER_BINARY "${CMAKE_CURRENT_BINARY_DIR}/generated/${SHADER_NAME}.spv")
    set(SHADER_HEADER "${CMAKE_CURRENT_BINARY_DIR}/generated/${SHADER_NAME}.h")
    add_custom_command(OUTPUT "${SHADER_HEADER}" BYPRODUCTS "${SHADER_BINARY}"
        COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_CURRENT_BINARY_DIR}/generated"
        COMMAND "${DXC_EXECUTABLE}" -spirv -T cs_6_0 -E main -HV 2021
            -fspv-target-env=vulkan1.1 -fvk-use-gl-layout -Ges -WX
            ${ARGN} -Fo "${SHADER_BINARY}" "${SHADER}"
        COMMAND "${CMAKE_COMMAND}" "-DINPUT=${SHADER_BINARY}" "-DOUTPUT=${SHADER_HEADER}" "-DNAME=${SHADER_NAME}" -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_shader.cmake"
        DEPENDS "${SHADER}" ${SHADER_INCLUDES} "${DXC_EXECUTABLE}" cmake/embed_shader.cmake
        VERBATIM)
    set(GENERATED_SHADER_HEADERS ${GENERATED_SHADER_HEADERS} "${SHADER_HEADER}" PARENT_SCOPE)
endfunction()

foreach(SHADER IN LISTS COMPUTE_SHADERS)
    get_filename_component(SHADER_NAME "${SHADER}" NAME_WE)
    if(NOT SHADER_NAME STREQUAL "cluster")
        compile_compute_shader("${SHADER_NAME}" "${SHADER}")
    endif()
endforeach()

# HLSL array extents must be compile-time constants. Preserve the existing SH
# widths and adaptive shared-memory tile sizes through embedded variants.
set(CLUSTER_HEADER "#pragma once\n#include <array>\n#include <span>\n#include <string_view>\n")
set(CLUSTER_VARIANTS)
foreach(COLUMNS IN ITEMS 3 6 12)
    foreach(TILE IN ITEMS 1 2 4 8 16 32 64 128)
        set(NAME "cluster_${COLUMNS}_${TILE}")
        compile_compute_shader("${NAME}" "${CMAKE_CURRENT_SOURCE_DIR}/shaders/cluster.hlsl"
            "-DVEC_COLUMNS=${COLUMNS}" "-DTILE_SIZE=${TILE}")
        string(APPEND CLUSTER_HEADER "#include \"${NAME}.h\"\n")
        string(APPEND CLUSTER_VARIANTS "    ClusterShader { \"${NAME}\", ${COLUMNS}, ${TILE}, ${NAME} },\n")
    endforeach()
endforeach()
string(APPEND CLUSTER_HEADER "namespace splat_transform::gpu::vulkan::shaders {\nstruct ClusterShader {\n    std::string_view name;\n    uint32_t columns;\n    uint32_t tile;\n    std::span<const uint8_t> spirv;\n};\ninline constexpr std::array cluster_variants {\n${CLUSTER_VARIANTS}};\n}\n")
file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/generated/cluster.h" CONTENT "${CLUSTER_HEADER}")
list(APPEND GENERATED_SHADER_HEADERS "${CMAKE_CURRENT_BINARY_DIR}/generated/cluster.h")

target_sources(splat_transform_core
    PRIVATE ${COMPUTE_SHADERS} ${SHADER_INCLUDES}
    PRIVATE FILE_SET core_generated_headers
        TYPE HEADERS
        BASE_DIRS "${CMAKE_CURRENT_BINARY_DIR}/generated"
        FILES ${GENERATED_SHADER_HEADERS}
)
set_source_files_properties(${COMPUTE_SHADERS} ${SHADER_INCLUDES} PROPERTIES HEADER_FILE_ONLY TRUE)
source_group(TREE "${CMAKE_CURRENT_SOURCE_DIR}" FILES ${COMPUTE_SHADERS} ${SHADER_INCLUDES})
source_group("generated\\shaders" FILES ${GENERATED_SHADER_HEADERS})
