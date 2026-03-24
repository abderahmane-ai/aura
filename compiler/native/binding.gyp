{
  "variables": {
    "cuda_path%": "<!(node -e \"process.stdout.write(process.env.CUDA_PATH || '')\")"
  },
  "targets": [
    {
      "target_name": "aura_cuda",
      "sources": [ "aura_cuda.cc" ],
      "include_dirs": [ "<(cuda_path)/include" ],
      "libraries": [
        "<(cuda_path)/lib/x64/cudart.lib",
        "<(cuda_path)/lib/x64/nvrtc.lib",
        "<(cuda_path)/lib/x64/cuda.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": [ "/std:c++17", "/EHsc" ]
        }
      }
    }
  ]
}
