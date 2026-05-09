# splat-transform

A 3DGS modifier used by aholo

## Requirement

- node >= 20.19.0
- system
  - windows: windows 22H2+, x86_64, D3D12 or Vulkan compatible GPU(When use GPU features, dedicated GPU for better performance)
  - linux: x86_64, glibc >= 2.34, libstdc++ >= 3.4.30, Vulkan compatible GPU(When use GPU features, dedicated GPU for better performance)
  - osx: Not Supported

## Usage

```bash
npm install @manycore/aholo-splat-transform -g

splat-transform --help

Execute a task pipeline from configuration file

Arguments:
  path                                       pipeline config filepath

Options:
  -V, --version                              output the version number
  -h, --help                                 display help for command

Commands:
  create <input> <output>                    Merge & Transform gaussian splat file
  lod:loading [options] <input> <output>     Generate loading-lod for gaussian splat file
  lod:flex [options] <input> <output>        Generate flex-lod for gaussian splat file
  lod:auto [options] <input> <output>        Generate auto-lod for gaussian splat file
  lod:auto-chunk [options] <input> <output>  Generate auto-chunk-lod for gaussian splat file
```

## Notice

The code of the tool(AKA. `@manycore/aholo-splat-transform`) is not open source, you may use the the tool to generate content for any purpose, but you cannot redistribute the tool.
