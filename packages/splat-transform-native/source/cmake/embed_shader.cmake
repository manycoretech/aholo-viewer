file(READ "${INPUT}" SHADER_HEX HEX)
string(REGEX REPLACE "(..)" "0x\\1," SHADER_BYTES "${SHADER_HEX}")
file(WRITE "${OUTPUT}" "#pragma once\n#include <cstdint>\nnamespace splat_transform::gpu::vulkan::shaders {\nalignas(4) inline constexpr uint8_t ${NAME}[] = { ${SHADER_BYTES} };\n}\n")
