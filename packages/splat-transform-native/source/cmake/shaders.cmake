include("${CMAKE_CURRENT_LIST_DIR}/shader-inputs.cmake")

# Reuse matching headers, including the Windows CI artifact, without DXC.
# Local builds generate headers only when they are missing or out of date.
set(SHADER_GENERATION_HELP
    "Install a SPIR-V-enabled DXC on PATH, set the DXC_EXECUTABLE environment variable, or configure with -DDXC_EXECUTABLE=/path/to/dxc. Alternatively, download this revision's native-shader-headers CI artifact into ${SHADER_OUTPUT_DIR}.")
set(SHADER_REGENERATION_REASON "")
foreach(HEADER IN LISTS GENERATED_SHADER_HEADERS)
    if(NOT EXISTS "${HEADER}")
        set(SHADER_REGENERATION_REASON "Missing shader header: ${HEADER}")
        break()
    endif()
endforeach()

if(NOT SHADER_REGENERATION_REASON)
    file(STRINGS "${SHADER_OUTPUT_DIR}/cluster.h" SHADER_INPUT_STAMP
        LIMIT_COUNT 1 REGEX "^// shader-input-sha256: ")
    if(NOT SHADER_INPUT_STAMP STREQUAL "// shader-input-sha256: ${SHADER_INPUT_HASH}")
        set(SHADER_REGENERATION_REASON "Shader headers are out of date for the current sources or generation scripts")
    endif()
endif()

set(SHADER_GENERATION_OPTIONS "-DSHADER_OUTPUT_DIR=${SHADER_OUTPUT_DIR}")
if(DEFINED DXC_EXECUTABLE AND NOT DXC_EXECUTABLE STREQUAL "")
    list(APPEND SHADER_GENERATION_OPTIONS "-DDXC_EXECUTABLE=${DXC_EXECUTABLE}")
endif()
if(SHADER_REGENERATION_REASON)
    message(STATUS "${SHADER_REGENERATION_REASON}; generating shaders")
    execute_process(
        COMMAND "${CMAKE_COMMAND}" ${SHADER_GENERATION_OPTIONS} -P "${CMAKE_CURRENT_LIST_DIR}/compile-shaders.cmake"
        RESULT_VARIABLE SHADER_GENERATION_RESULT)
    if(NOT SHADER_GENERATION_RESULT STREQUAL "0")
        message(FATAL_ERROR "Automatic shader generation failed: ${SHADER_GENERATION_RESULT}\n${SHADER_GENERATION_HELP}")
    endif()
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    ${SHADER_INPUTS} ${GENERATED_SHADER_HEADERS})

target_sources(splat_transform_core
    PRIVATE ${COMPUTE_SHADERS} ${SHADER_INCLUDES}
    PRIVATE FILE_SET core_generated_headers
        TYPE HEADERS
        BASE_DIRS "${SHADER_OUTPUT_DIR}"
        FILES ${GENERATED_SHADER_HEADERS}
)
set_source_files_properties(${COMPUTE_SHADERS} ${SHADER_INCLUDES} PROPERTIES HEADER_FILE_ONLY TRUE)
source_group(TREE "${CMAKE_CURRENT_SOURCE_DIR}" FILES ${COMPUTE_SHADERS} ${SHADER_INCLUDES})
source_group("generated\\shaders" FILES ${GENERATED_SHADER_HEADERS})
