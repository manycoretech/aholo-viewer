cmake_minimum_required(VERSION 3.31)

string(RANDOM LENGTH 16 run_id)
set(root "${CMAKE_CURRENT_BINARY_DIR}/pipeline-paths-${run_id}")
set(work "${root}/work")
set(configs "${root}/config files")
set(file "${configs}/pipeline.json")
foreach(dir IN ITEMS "${work}" "${configs}")
    execute_process(COMMAND "${FIXTURES}" --prepare "${dir}" COMMAND_ERROR_IS_FATAL ANY)
endforeach()
# The same relative input name has 7 points under workDir and 12 under pipelineDir.
file(COPY_FILE "${work}/inputs/second.ply" "${work}/inputs/first.ply")
set(probe [=[
{
    "version": 2,
    "tasks": [
        {"type":"Read","config":{"inputs":["inputs/first.ply"],"output":"source"}},
        {"type":"Write","config":{"input":"source","output":"probe.splat"}}
    ]
}
]=])

function(check_base json entry dir expected_bytes)
    file(WRITE "${file}" "${json}")
    execute_process(COMMAND "${CLI}" "${entry}" WORKING_DIRECTORY "${work}"
        INPUT_FILE "${file}" ERROR_VARIABLE warning ERROR_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
    if(NOT warning STREQUAL "${ARGV4}")
        message(FATAL_ERROR "Expected stderr '${ARGV4}', got '${warning}'")
    endif()
    file(SIZE "${dir}/probe.splat" actual)
    if(NOT actual EQUAL expected_bytes)
        message(FATAL_ERROR "Expected ${expected_bytes} bytes at ${dir}/probe.splat, got ${actual}")
    endif()
    file(REMOVE "${dir}/probe.splat")
endfunction()

set(entry "../config files/pipeline.json")
check_base("${probe}" "${entry}" "${configs}" 384)
string(JSON v1 SET "${probe}" version 1)
check_base("${v1}" "${entry}" "${work}" 224)
string(JSON unversioned REMOVE "${probe}" version)
check_base("${unversioned}" "${entry}" "${configs}" 384)
check_base("${unversioned}" - "${work}" 224)
string(JSON unknown SET "${probe}" version 3)
set(warning "Unrecognized pipeline version 3. Using version 2.")
check_base("${unknown}" "${entry}" "${configs}" 384 "${warning}")
check_base("${unknown}" - "${work}" 224 "${warning}")
string(JSON work_base SET "${probe}" base [["workDir"]])
check_base("${work_base}" "${entry}" "${work}" 224)
string(JSON override SET "${work_base}" tasks 0 config inputs 0 [["${pipelineDir}/inputs/first.ply"]])
string(JSON override SET "${override}" tasks 1 config output [["${pipelineDir}/probe.splat"]])
check_base("${override}" "${entry}" "${configs}" 384)
string(JSON file_base SET "${probe}" base [["pipelineDir"]])
check_base("${file_base}" "${entry}" "${configs}" 384)
check_base("${probe}" - "${work}" 224)
string(JSON stdin_vars SET "${file_base}" tasks 0 config inputs 0 [["${pipelineDir}/inputs/first.ply"]])
string(JSON stdin_vars SET "${stdin_vars}" tasks 1 config output [["${workDir}/probe.splat"]])
check_base("${stdin_vars}" - "${work}" 224)
string(JSON unknown_base SET "${v1}" base [["elsewhere"]])
set(base_warning "Unrecognized pipeline base elsewhere. Using pipelineDir.")
check_base("${unknown_base}" "${entry}" "${configs}" 384 "${base_warning}")
string(JSON both_unknown SET "${unknown}" base [["elsewhere"]])
check_base("${both_unknown}" - "${work}" 224 "${warning}\n${base_warning}")

# Mix both directories, then re-read the same input through a different spelling.
# The voxel/LOD link exercises the input identity and output metadata paths.
file(WRITE "${work}/selection.json" "[0,1,2,3]")
file(WRITE "${file}" [=[
{
    "version": 2,
    "tasks": [
        {"type":"Read","config":{"inputs":["inputs/first.ply"],"output":"source"}},
        {"type":"AutoChunkLod","config":{"input":"source","output":"lod","type":"esz","levels":[{"precision":1,"scaleBoost":1}]}},
        {"type":"Write","config":{"input":"lod","output":"lod"}},
        {"type":"Read","config":{"inputs":["${pipelineDir}/inputs/first.ply"],"output":"again"}},
        {"type":"Voxel","config":{"input":"again","output":"${workDir}/voxels","backend":"cpu","filterCluster":false,"voxelResolution":0.5}},
        {"type":"Modify","config":{"input":"again","output":"modified","modifyPaths":["${pipelineDir}/inputs/first.json"]}},
        {"type":"Select","config":{"input":"modified","output":"selected","indicesPath":"${workDir}/selection.json"}},
        {"type":"FlexLod","config":{"input":"selected","output":"best","ratio":0.5,"scorePath":"inputs/scores.bin","originalIndices":"${workDir}/indices.bin"}},
        {"type":"Write","config":{"input":"best","output":"${workDir}/result.splat"}}
    ]
}
]=])
execute_process(COMMAND "${CLI}" "${entry}" WORKING_DIRECTORY "${work}" COMMAND_ERROR_IS_FATAL ANY)
file(READ "${configs}/lod/lod-meta.json" meta)
string(JSON link GET "${meta}" voxels 0)
file(SIZE "${work}/result.splat" result_bytes)
file(READ "${work}/indices.bin" indices HEX)
if(NOT link STREQUAL "../../work/voxels/voxel-meta.json" OR NOT EXISTS "${configs}/lod/${link}"
        OR NOT result_bytes EQUAL 64 OR NOT indices STREQUAL "0200000003000000")
    message(FATAL_ERROR "Unexpected V2 task outputs or metadata link: ${link}, ${result_bytes} bytes, indices ${indices}")
endif()
file(REMOVE_RECURSE "${root}")
