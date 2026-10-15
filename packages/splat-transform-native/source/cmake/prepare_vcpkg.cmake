cmake_minimum_required(VERSION 3.31)
find_package(Git REQUIRED)
if(NOT DEFINED VCPKG_ROOT)
    set(VCPKG_ROOT "$ENV{VCPKG_ROOT}")
endif()
if(NOT VCPKG_ROOT)
    message(FATAL_ERROR "Set VCPKG_ROOT to the vcpkg checkout directory")
endif()

file(READ "${CMAKE_CURRENT_LIST_DIR}/../vcpkg-configuration.json" registry)
string(JSON baseline GET "${registry}" default-registry baseline)
if(NOT EXISTS "${VCPKG_ROOT}/.git")
    file(GLOB contents "${VCPKG_ROOT}/*")
    if(contents)
        message(FATAL_ERROR "Refusing to initialize vcpkg in a nonempty directory: ${VCPKG_ROOT}")
    endif()
    execute_process(COMMAND "${GIT_EXECUTABLE}" init "${VCPKG_ROOT}" COMMAND_ERROR_IS_FATAL ANY)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -C "${VCPKG_ROOT}" remote add origin https://github.com/microsoft/vcpkg
        COMMAND_ERROR_IS_FATAL ANY
    )
endif()
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${VCPKG_ROOT}" cat-file -e "${baseline}:versions/baseline.json"
    RESULT_VARIABLE baseline_missing OUTPUT_QUIET ERROR_QUIET
)
if(baseline_missing)
    message(STATUS "Fetching vcpkg baseline ${baseline} with depth 1")
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -C "${VCPKG_ROOT}" fetch --depth 1 --no-tags origin "${baseline}"
        COMMAND_ERROR_IS_FATAL ANY
    )
endif()
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${VCPKG_ROOT}" show "${baseline}:versions/baseline.json"
    OUTPUT_QUIET COMMAND_ERROR_IS_FATAL ANY
)
message(STATUS "vcpkg baseline ${baseline} is available")
execute_process(
    COMMAND "${GIT_EXECUTABLE}" -C "${VCPKG_ROOT}" rev-parse HEAD
    OUTPUT_VARIABLE current_ref OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET
)
if(NOT current_ref STREQUAL baseline)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -C "${VCPKG_ROOT}" status --porcelain --untracked-files=no
        OUTPUT_VARIABLE changes OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY
    )
    if(changes)
        message(FATAL_ERROR "Refusing to switch a modified vcpkg checkout: ${VCPKG_ROOT}")
    endif()
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" -C "${VCPKG_ROOT}" checkout --detach "${baseline}"
        COMMAND_ERROR_IS_FATAL ANY
    )
    set(bootstrap_required TRUE)
endif()
if(CMAKE_HOST_WIN32)
    set(bootstrap "${VCPKG_ROOT}/bootstrap-vcpkg.bat")
    set(vcpkg_program "${VCPKG_ROOT}/vcpkg.exe")
else()
    set(bootstrap "${VCPKG_ROOT}/bootstrap-vcpkg.sh")
    set(vcpkg_program "${VCPKG_ROOT}/vcpkg")
endif()
if(bootstrap_required OR NOT EXISTS "${vcpkg_program}")
    execute_process(COMMAND "${bootstrap}" -disableMetrics COMMAND_ERROR_IS_FATAL ANY)
endif()
