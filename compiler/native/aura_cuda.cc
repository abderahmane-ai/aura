#include <node_api.h>

#include <cuda.h>
#include <cuda_runtime_api.h>
#include <nvrtc.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

constexpr int kThreads = 256;
constexpr const char* kDevice = "cuda:0";

struct DeviceTensor {
  std::vector<int64_t> shape;
  size_t size = 0;
  double* data = nullptr;
};

bool g_cuda_checked = false;
bool g_cuda_available = false;
int g_cuda_device_count = 0;
bool g_driver_ready = false;
bool g_module_ready = false;
CUmodule g_module = nullptr;
std::unordered_map<std::string, CUfunction> g_functions;

const char* kKernelSource = R"CUDA(
extern "C" __device__ long long broadcast_offset(int rank, long long s0, long long s1, int out_rank, long long o1, long long idx) {
    long long r = 0;
    long long c = 0;
    if (out_rank == 1) {
        c = idx;
    } else {
        r = idx / o1;
        c = idx % o1;
    }
    if (rank == 1) {
        return s0 == 1 ? 0 : c;
    }
    long long rr = s0 == 1 ? 0 : r;
    long long cc = s1 == 1 ? 0 : c;
    return rr * s1 + cc;
}

extern "C" __global__ void unary_kernel(const double* in, double* out, long long n, int op, double p1, double p2) {
    long long idx = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= n) return;
    double x = in[idx];
    double y = x;
    switch (op) {
        case 0: y = exp(x); break;
        case 1: y = log(x); break;
        case 2: y = 1.0 / (1.0 + exp(-x)); break;
        case 3: y = x > 0.0 ? x : 0.0; break;
        case 4: y = tanh(x); break;
        case 5: y = fabs(x); break;
        case 6: y = sqrt(x); break;
        case 7: y = x < p1 ? p1 : (x > p2 ? p2 : x); break;
    }
    out[idx] = y;
}

extern "C" __global__ void binary_kernel(
    const double* a,
    const double* b,
    double* out,
    int a_rank,
    long long a0,
    long long a1,
    int b_rank,
    long long b0,
    long long b1,
    int out_rank,
    long long o1,
    long long total,
    int op) {
    long long idx = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= total) return;
    long long ao = broadcast_offset(a_rank, a0, a1, out_rank, o1, idx);
    long long bo = broadcast_offset(b_rank, b0, b1, out_rank, o1, idx);
    double x = a[ao];
    double y = b[bo];
    double v = x;
    switch (op) {
        case 0: v = x + y; break;
        case 1: v = x - y; break;
        case 2: v = x * y; break;
        case 3: v = x / y; break;
        case 4: v = pow(x, y); break;
    }
    out[idx] = v;
}

extern "C" __global__ void fill_kernel(double* out, long long n, double value) {
    long long idx = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (idx < n) out[idx] = value;
}

extern "C" __global__ void transpose2d_kernel(const double* in, double* out, long long rows, long long cols) {
    long long idx = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    long long total = rows * cols;
    if (idx >= total) return;
    long long r = idx / cols;
    long long c = idx % cols;
    out[c * rows + r] = in[r * cols + c];
}

extern "C" __global__ void reduce_sum_kernel(const double* in, double* out, long long n) {
    __shared__ double shared[256];
    unsigned int tid = threadIdx.x;
    double acc = 0.0;
    for (long long i = tid; i < n; i += blockDim.x) acc += in[i];
    shared[tid] = acc;
    __syncthreads();
    for (unsigned int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (tid < stride) shared[tid] += shared[tid + stride];
        __syncthreads();
    }
    if (tid == 0) out[0] = shared[0];
}

extern "C" __global__ void reduce_bce_kernel(const double* pred, const double* target, double* out, long long n, double eps) {
    __shared__ double shared[256];
    unsigned int tid = threadIdx.x;
    double acc = 0.0;
    for (long long i = tid; i < n; i += blockDim.x) {
        double p = pred[i];
        if (p < eps) p = eps;
        if (p > 1.0 - eps) p = 1.0 - eps;
        double y = target[i];
        acc += -(y * log(p) + (1.0 - y) * log(1.0 - p));
    }
    shared[tid] = acc;
    __syncthreads();
    for (unsigned int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (tid < stride) shared[tid] += shared[tid + stride];
        __syncthreads();
    }
    if (tid == 0) out[0] = shared[0] / (double)n;
}

extern "C" __global__ void reduce_axis_sum_kernel(const double* in, double* out, long long rows, long long cols, int axis, int mean) {
    long long idx = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (axis == 0) {
        if (idx >= cols) return;
        double acc = 0.0;
        for (long long r = 0; r < rows; ++r) acc += in[r * cols + idx];
        out[idx] = mean ? acc / (double)rows : acc;
        return;
    }
    if (idx >= rows) return;
    double acc = 0.0;
    for (long long c = 0; c < cols; ++c) acc += in[idx * cols + c];
    out[idx] = mean ? acc / (double)cols : acc;
}

extern "C" __global__ void reduce_axis_max_kernel(const double* in, double* out, long long rows, long long cols, int axis) {
    long long idx = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (axis == 0) {
        if (idx >= cols) return;
        double best = in[idx];
        for (long long r = 1; r < rows; ++r) {
            double v = in[r * cols + idx];
            if (v > best) best = v;
        }
        out[idx] = best;
        return;
    }
    if (idx >= rows) return;
    double best = in[idx * cols];
    for (long long c = 1; c < cols; ++c) {
        double v = in[idx * cols + c];
        if (v > best) best = v;
    }
    out[idx] = best;
}

extern "C" __global__ void take_rows_kernel(const double* in, const long long* indices, double* out, long long cols, long long out_rows, int rank) {
    long long idx = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    long long total = rank == 1 ? out_rows : out_rows * cols;
    if (idx >= total) return;
    if (rank == 1) {
        out[idx] = in[indices[idx]];
        return;
    }
    long long r = idx / cols;
    long long c = idx % cols;
    out[idx] = in[indices[r] * cols + c];
}

extern "C" __global__ void softmax_rank1_kernel(const double* in, double* out, long long n, int log_output) {
    __shared__ double max_shared[256];
    __shared__ double sum_shared[256];
    unsigned int tid = threadIdx.x;
    double local_max = -1.7976931348623157e308;
    for (long long i = tid; i < n; i += blockDim.x) local_max = in[i] > local_max ? in[i] : local_max;
    max_shared[tid] = local_max;
    __syncthreads();
    for (unsigned int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (tid < stride) max_shared[tid] = max_shared[tid] > max_shared[tid + stride] ? max_shared[tid] : max_shared[tid + stride];
        __syncthreads();
    }
    double maxv = max_shared[0];
    double local_sum = 0.0;
    for (long long i = tid; i < n; i += blockDim.x) local_sum += exp(in[i] - maxv);
    sum_shared[tid] = local_sum;
    __syncthreads();
    for (unsigned int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (tid < stride) sum_shared[tid] += sum_shared[tid + stride];
        __syncthreads();
    }
    double denom = sum_shared[0];
    for (long long i = tid; i < n; i += blockDim.x) {
        double v = exp(in[i] - maxv) / denom;
        out[i] = log_output ? log(v) : v;
    }
}

extern "C" __global__ void softmax_axis1_kernel(const double* in, double* out, long long rows, long long cols, int log_output) {
    long long row = blockIdx.x;
    if (row >= rows) return;
    __shared__ double max_shared[256];
    __shared__ double sum_shared[256];
    unsigned int tid = threadIdx.x;
    double local_max = -1.7976931348623157e308;
    for (long long c = tid; c < cols; c += blockDim.x) {
        double v = in[row * cols + c];
        local_max = v > local_max ? v : local_max;
    }
    max_shared[tid] = local_max;
    __syncthreads();
    for (unsigned int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (tid < stride) max_shared[tid] = max_shared[tid] > max_shared[tid + stride] ? max_shared[tid] : max_shared[tid + stride];
        __syncthreads();
    }
    double maxv = max_shared[0];
    double local_sum = 0.0;
    for (long long c = tid; c < cols; c += blockDim.x) local_sum += exp(in[row * cols + c] - maxv);
    sum_shared[tid] = local_sum;
    __syncthreads();
    for (unsigned int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (tid < stride) sum_shared[tid] += sum_shared[tid + stride];
        __syncthreads();
    }
    double denom = sum_shared[0];
    for (long long c = tid; c < cols; c += blockDim.x) {
        double v = exp(in[row * cols + c] - maxv) / denom;
        out[row * cols + c] = log_output ? log(v) : v;
    }
}

extern "C" __global__ void matmul_vv_kernel(const double* a, const double* b, double* out, long long n) {
    __shared__ double shared[256];
    unsigned int tid = threadIdx.x;
    double acc = 0.0;
    for (long long i = tid; i < n; i += blockDim.x) acc += a[i] * b[i];
    shared[tid] = acc;
    __syncthreads();
    for (unsigned int stride = blockDim.x / 2; stride > 0; stride >>= 1) {
        if (tid < stride) shared[tid] += shared[tid + stride];
        __syncthreads();
    }
    if (tid == 0) out[0] = shared[0];
}

extern "C" __global__ void matmul_mv_kernel(const double* a, const double* b, double* out, long long rows, long long inner) {
    long long row = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (row >= rows) return;
    double acc = 0.0;
    for (long long k = 0; k < inner; ++k) acc += a[row * inner + k] * b[k];
    out[row] = acc;
}

extern "C" __global__ void matmul_vm_kernel(const double* a, const double* b, double* out, long long inner, long long cols) {
    long long col = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (col >= cols) return;
    double acc = 0.0;
    for (long long k = 0; k < inner; ++k) acc += a[k] * b[k * cols + col];
    out[col] = acc;
}

extern "C" __global__ void matmul_mm_kernel(const double* a, const double* b, double* out, long long rows, long long inner, long long cols) {
    long long idx = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    long long total = rows * cols;
    if (idx >= total) return;
    long long row = idx / cols;
    long long col = idx % cols;
    double acc = 0.0;
    for (long long k = 0; k < inner; ++k) acc += a[row * inner + k] * b[k * cols + col];
    out[idx] = acc;
}
)CUDA";

void ThrowError(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

bool CheckNapi(napi_env env, napi_status status, const char* context) {
  if (status == napi_ok) return true;
  const napi_extended_error_info* info = nullptr;
  napi_get_last_error_info(env, &info);
  std::string message = context;
  if (info && info->error_message) {
    message += ": ";
    message += info->error_message;
  }
  ThrowError(env, message);
  return false;
}

bool CheckCuda(napi_env env, cudaError_t status, const char* context) {
  if (status == cudaSuccess) return true;
  ThrowError(env, std::string(context) + ": " + cudaGetErrorString(status));
  return false;
}

bool CheckDriver(napi_env env, CUresult status, const char* context) {
  if (status == CUDA_SUCCESS) return true;
  const char* msg = nullptr;
  cuGetErrorString(status, &msg);
  ThrowError(env, std::string(context) + ": " + (msg ? msg : "unknown CUDA driver error"));
  return false;
}

bool CheckNvrtc(napi_env env, nvrtcResult status, const char* context) {
  if (status == NVRTC_SUCCESS) return true;
  ThrowError(env, std::string(context) + ": " + nvrtcGetErrorString(status));
  return false;
}

size_t Numel(const std::vector<int64_t>& shape) {
  size_t size = 1;
  for (int64_t dim : shape) size *= static_cast<size_t>(dim);
  return size;
}

bool EnsureCudaState() {
  if (g_cuda_checked) return g_cuda_available;
  g_cuda_checked = true;
  cudaError_t status = cudaGetDeviceCount(&g_cuda_device_count);
  if (status != cudaSuccess || g_cuda_device_count <= 0) {
    g_cuda_available = false;
    g_cuda_device_count = 0;
    return false;
  }
  g_cuda_available = true;
  return true;
}

bool EnsureDriverReady(napi_env env) {
  if (!EnsureCudaState()) {
    ThrowError(env, "CUDA backend unavailable");
    return false;
  }
  if (g_driver_ready) return true;
  if (!CheckDriver(env, cuInit(0), "cuInit")) return false;
  if (!CheckCuda(env, cudaSetDevice(0), "cudaSetDevice")) return false;
  CUcontext ctx = nullptr;
  if (!CheckDriver(env, cuCtxGetCurrent(&ctx), "cuCtxGetCurrent")) return false;
  if (!ctx) {
    CUdevice device;
    if (!CheckDriver(env, cuDeviceGet(&device, 0), "cuDeviceGet")) return false;
    if (!CheckDriver(env, cuDevicePrimaryCtxRetain(&ctx, device), "cuDevicePrimaryCtxRetain")) return false;
    if (!CheckDriver(env, cuCtxSetCurrent(ctx), "cuCtxSetCurrent")) return false;
  }
  g_driver_ready = true;
  return true;
}

bool EnsureKernels(napi_env env) {
  if (g_module_ready) return true;
  if (!EnsureDriverReady(env)) return false;

  cudaDeviceProp prop{};
  if (!CheckCuda(env, cudaGetDeviceProperties(&prop, 0), "cudaGetDeviceProperties")) return false;
  std::string arch = "--gpu-architecture=compute_" + std::to_string(prop.major) + std::to_string(prop.minor);
  const char* opts[] = {"--std=c++14", arch.c_str()};

  nvrtcProgram program;
  if (!CheckNvrtc(env, nvrtcCreateProgram(&program, kKernelSource, "aura_cuda_kernels.cu", 0, nullptr, nullptr), "nvrtcCreateProgram")) return false;
  nvrtcResult compile_result = nvrtcCompileProgram(program, 2, opts);
  if (compile_result != NVRTC_SUCCESS) {
    size_t log_size = 0;
    nvrtcGetProgramLogSize(program, &log_size);
    std::string log(log_size, '\0');
    if (log_size > 0) nvrtcGetProgramLog(program, log.data());
    nvrtcDestroyProgram(&program);
    ThrowError(env, std::string("nvrtcCompileProgram: ") + log);
    return false;
  }

  size_t ptx_size = 0;
  if (!CheckNvrtc(env, nvrtcGetPTXSize(program, &ptx_size), "nvrtcGetPTXSize")) {
    nvrtcDestroyProgram(&program);
    return false;
  }
  std::string ptx(ptx_size, '\0');
  if (!CheckNvrtc(env, nvrtcGetPTX(program, ptx.data()), "nvrtcGetPTX")) {
    nvrtcDestroyProgram(&program);
    return false;
  }
  nvrtcDestroyProgram(&program);

  if (!CheckDriver(env, cuModuleLoadDataEx(&g_module, ptx.data(), 0, nullptr, nullptr), "cuModuleLoadDataEx")) return false;
  const char* names[] = {
      "unary_kernel", "binary_kernel", "fill_kernel", "transpose2d_kernel",
      "reduce_sum_kernel", "reduce_bce_kernel", "reduce_axis_sum_kernel", "reduce_axis_max_kernel",
      "take_rows_kernel", "softmax_rank1_kernel", "softmax_axis1_kernel",
      "matmul_vv_kernel", "matmul_mv_kernel", "matmul_vm_kernel", "matmul_mm_kernel"
  };
  for (const char* name : names) {
    CUfunction fn;
    if (!CheckDriver(env, cuModuleGetFunction(&fn, g_module, name), name)) return false;
    g_functions[name] = fn;
  }
  g_module_ready = true;
  return true;
}

CUfunction GetFunction(const std::string& name) {
  return g_functions.at(name);
}

bool Launch(napi_env env, const std::string& name, unsigned int blocks, unsigned int threads, void** params) {
  if (!EnsureKernels(env)) return false;
  CUfunction fn = GetFunction(name);
  if (!CheckDriver(env, cuLaunchKernel(fn, blocks, 1, 1, threads, 1, 1, 0, nullptr, params, nullptr), name.c_str())) return false;
  return CheckCuda(env, cudaGetLastError(), name.c_str());
}

bool GetNamedProperty(napi_env env, napi_value obj, const char* name, napi_value* out) {
  return CheckNapi(env, napi_get_named_property(env, obj, name, out), name);
}

bool HasNamedProperty(napi_env env, napi_value obj, const char* name, bool* out) {
  return CheckNapi(env, napi_has_named_property(env, obj, name, out), name);
}

std::string GetString(napi_env env, napi_value value) {
  size_t size = 0;
  if (!CheckNapi(env, napi_get_value_string_utf8(env, value, nullptr, 0, &size), "napi_get_value_string_utf8")) return {};
  std::string out(size, '\0');
  if (!CheckNapi(env, napi_get_value_string_utf8(env, value, out.data(), size + 1, &size), "napi_get_value_string_utf8")) return {};
  return out;
}

double GetNumber(napi_env env, napi_value value) {
  double out = 0.0;
  if (!CheckNapi(env, napi_get_value_double(env, value, &out), "napi_get_value_double")) return 0.0;
  return out;
}

bool GetBool(napi_env env, napi_value value) {
  bool out = false;
  if (!CheckNapi(env, napi_get_value_bool(env, value, &out), "napi_get_value_bool")) return false;
  return out;
}

std::vector<int64_t> GetIntArray(napi_env env, napi_value value) {
  uint32_t length = 0;
  if (!CheckNapi(env, napi_get_array_length(env, value, &length), "napi_get_array_length")) return {};
  std::vector<int64_t> out;
  out.reserve(length);
  for (uint32_t i = 0; i < length; ++i) {
    napi_value item;
    if (!CheckNapi(env, napi_get_element(env, value, i, &item), "napi_get_element")) return {};
    out.push_back(static_cast<int64_t>(std::llround(GetNumber(env, item))));
  }
  return out;
}

std::vector<double> GetDoubleArray(napi_env env, napi_value value) {
  uint32_t length = 0;
  if (!CheckNapi(env, napi_get_array_length(env, value, &length), "napi_get_array_length")) return {};
  std::vector<double> out;
  out.reserve(length);
  for (uint32_t i = 0; i < length; ++i) {
    napi_value item;
    if (!CheckNapi(env, napi_get_element(env, value, i, &item), "napi_get_element")) return {};
    out.push_back(GetNumber(env, item));
  }
  return out;
}

napi_value MakeString(napi_env env, const std::string& value) {
  napi_value out;
  CheckNapi(env, napi_create_string_utf8(env, value.c_str(), value.size(), &out), "napi_create_string_utf8");
  return out;
}

napi_value MakeBool(napi_env env, bool value) {
  napi_value out;
  CheckNapi(env, napi_get_boolean(env, value, &out), "napi_get_boolean");
  return out;
}

napi_value MakeNumber(napi_env env, double value) {
  napi_value out;
  CheckNapi(env, napi_create_double(env, value, &out), "napi_create_double");
  return out;
}

napi_value MakeIntArray(napi_env env, const std::vector<int64_t>& values) {
  napi_value out;
  CheckNapi(env, napi_create_array_with_length(env, values.size(), &out), "napi_create_array_with_length");
  for (uint32_t i = 0; i < values.size(); ++i) {
    napi_value item = MakeNumber(env, static_cast<double>(values[i]));
    CheckNapi(env, napi_set_element(env, out, i, item), "napi_set_element");
  }
  return out;
}

napi_value MakeDoubleArray(napi_env env, const std::vector<double>& values) {
  napi_value out;
  CheckNapi(env, napi_create_array_with_length(env, values.size(), &out), "napi_create_array_with_length");
  for (uint32_t i = 0; i < values.size(); ++i) {
    napi_value item = MakeNumber(env, values[i]);
    CheckNapi(env, napi_set_element(env, out, i, item), "napi_set_element");
  }
  return out;
}

void TensorFinalizer(napi_env, void* data, void*) {
  auto* tensor = static_cast<DeviceTensor*>(data);
  if (!tensor) return;
  if (tensor->data) cudaFree(tensor->data);
  delete tensor;
}

DeviceTensor* AllocateTensor(napi_env env, const std::vector<int64_t>& shape) {
  auto* tensor = new DeviceTensor();
  tensor->shape = shape;
  tensor->size = Numel(shape);
  if (tensor->size > 0) {
    if (!CheckCuda(env, cudaMalloc(reinterpret_cast<void**>(&tensor->data), tensor->size * sizeof(double)), "cudaMalloc")) {
      delete tensor;
      return nullptr;
    }
  }
  return tensor;
}

std::vector<double> CopyToHost(napi_env env, const DeviceTensor* tensor) {
  std::vector<double> out(tensor->size);
  if (tensor->size > 0) {
    if (!CheckCuda(env, cudaMemcpy(out.data(), tensor->data, tensor->size * sizeof(double), cudaMemcpyDeviceToHost), "cudaMemcpyDeviceToHost")) {
      return {};
    }
  }
  return out;
}

napi_value MakeTensorObject(napi_env env, DeviceTensor* tensor, const std::vector<double>& host_values) {
  napi_value obj;
  if (!CheckNapi(env, napi_create_object(env, &obj), "napi_create_object")) return nullptr;
  napi_value handle;
  if (!CheckNapi(env, napi_create_external(env, tensor, TensorFinalizer, nullptr, &handle), "napi_create_external")) return nullptr;
  CheckNapi(env, napi_set_named_property(env, obj, "shape", MakeIntArray(env, tensor->shape)), "shape");
  CheckNapi(env, napi_set_named_property(env, obj, "values", MakeDoubleArray(env, host_values)), "values");
  CheckNapi(env, napi_set_named_property(env, obj, "device", MakeString(env, kDevice)), "device");
  CheckNapi(env, napi_set_named_property(env, obj, "dtype", MakeString(env, "float64")), "dtype");
  CheckNapi(env, napi_set_named_property(env, obj, "backend", MakeString(env, "cuda")), "backend");
  CheckNapi(env, napi_set_named_property(env, obj, "handle", handle), "handle");
  return obj;
}

napi_value MakeCpuTensorObject(napi_env env, const std::vector<int64_t>& shape, const std::vector<double>& values) {
  napi_value obj;
  if (!CheckNapi(env, napi_create_object(env, &obj), "napi_create_object")) return nullptr;
  CheckNapi(env, napi_set_named_property(env, obj, "shape", MakeIntArray(env, shape)), "shape");
  CheckNapi(env, napi_set_named_property(env, obj, "values", MakeDoubleArray(env, values)), "values");
  CheckNapi(env, napi_set_named_property(env, obj, "device", MakeString(env, "cpu")), "device");
  CheckNapi(env, napi_set_named_property(env, obj, "dtype", MakeString(env, "float64")), "dtype");
  CheckNapi(env, napi_set_named_property(env, obj, "backend", MakeString(env, "cpu")), "backend");
  return obj;
}

DeviceTensor* ParseTensorHandle(napi_env env, napi_value value) {
  napi_value handle_value;
  if (!GetNamedProperty(env, value, "handle", &handle_value)) return nullptr;
  DeviceTensor* tensor = nullptr;
  if (!CheckNapi(env, napi_get_value_external(env, handle_value, reinterpret_cast<void**>(&tensor)), "napi_get_value_external")) return nullptr;
  if (!tensor) ThrowError(env, "CUDA tensor handle is null");
  return tensor;
}

DeviceTensor* ParseCudaTensorArg(napi_env env, napi_value value) {
  napi_value backend_value;
  if (!GetNamedProperty(env, value, "backend", &backend_value)) return nullptr;
  if (GetString(env, backend_value) != "cuda") {
    ThrowError(env, "Mixed-device tensor ops are not supported; expected cuda tensor argument");
    return nullptr;
  }
  return ParseTensorHandle(env, value);
}

bool BroadcastShape(const std::vector<int64_t>& a, const std::vector<int64_t>& b, std::vector<int64_t>* out) {
  int n = static_cast<int>(std::max(a.size(), b.size()));
  out->assign(n, 1);
  for (int i = 0; i < n; ++i) {
    int64_t da = (static_cast<int>(a.size()) - 1 - i >= 0) ? a[a.size() - 1 - i] : 1;
    int64_t db = (static_cast<int>(b.size()) - 1 - i >= 0) ? b[b.size() - 1 - i] : 1;
    if (da != db && da != 1 && db != 1) return false;
    (*out)[n - 1 - i] = std::max(da, db);
  }
  return true;
}

int NormalizeAxis(int axis, int rank) {
  int resolved = axis;
  if (resolved < 0) resolved += rank;
  if (resolved < 0 || resolved >= rank) throw std::runtime_error("axis out of range");
  return resolved;
}

bool CopyDeviceToDevice(napi_env env, DeviceTensor* dst, const DeviceTensor* src) {
  if (dst->size != src->size) {
    ThrowError(env, "device-to-device copy shape mismatch");
    return false;
  }
  return CheckCuda(env, cudaMemcpy(dst->data, src->data, dst->size * sizeof(double), cudaMemcpyDeviceToDevice), "cudaMemcpyDeviceToDevice");
}

double GetOptionNumber(napi_env env, napi_value options, const char* name, double fallback) {
  bool has = false;
  if (!HasNamedProperty(env, options, name, &has) || !has) return fallback;
  napi_value value;
  if (!GetNamedProperty(env, options, name, &value)) return fallback;
  return GetNumber(env, value);
}

bool GetOptionBool(napi_env env, napi_value options, const char* name, bool fallback) {
  bool has = false;
  if (!HasNamedProperty(env, options, name, &has) || !has) return fallback;
  napi_value value;
  if (!GetNamedProperty(env, options, name, &value)) return fallback;
  return GetBool(env, value);
}

std::vector<int64_t> GetOptionIntArray(napi_env env, napi_value options, const char* name) {
  napi_value value;
  if (!GetNamedProperty(env, options, name, &value)) return {};
  return GetIntArray(env, value);
}

napi_value CudaAvailable(napi_env env, napi_callback_info) {
  return MakeBool(env, EnsureCudaState());
}

napi_value DeviceCount(napi_env env, napi_callback_info) {
  EnsureCudaState();
  return MakeNumber(env, static_cast<double>(g_cuda_device_count));
}

napi_value Synchronize(napi_env env, napi_callback_info) {
  if (!EnsureDriverReady(env)) return nullptr;
  if (!CheckCuda(env, cudaDeviceSynchronize(), "cudaDeviceSynchronize")) return nullptr;
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

napi_value CreateTensor(napi_env env, napi_callback_info info) {
  if (!EnsureDriverReady(env)) return nullptr;
  size_t argc = 3;
  napi_value argv[3];
  if (!CheckNapi(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "napi_get_cb_info")) return nullptr;
  if (argc < 3) {
    ThrowError(env, "createTensor(shape, values, device) expects 3 arguments");
    return nullptr;
  }
  std::vector<int64_t> shape = GetIntArray(env, argv[0]);
  std::vector<double> values = GetDoubleArray(env, argv[1]);
  std::string device = GetString(env, argv[2]);
  if (device != kDevice) {
    ThrowError(env, "Unsupported CUDA device; only cuda:0 is supported");
    return nullptr;
  }
  if (Numel(shape) != values.size()) {
    ThrowError(env, "createTensor shape/value length mismatch");
    return nullptr;
  }
  DeviceTensor* tensor = AllocateTensor(env, shape);
  if (!tensor) return nullptr;
  if (tensor->size > 0 && !CheckCuda(env, cudaMemcpy(tensor->data, values.data(), tensor->size * sizeof(double), cudaMemcpyHostToDevice), "cudaMemcpyHostToDevice")) {
    TensorFinalizer(env, tensor, nullptr);
    return nullptr;
  }
  return MakeTensorObject(env, tensor, values);
}

napi_value ToCPU(napi_env env, napi_callback_info info) {
  if (!EnsureDriverReady(env)) return nullptr;
  size_t argc = 1;
  napi_value argv[1];
  if (!CheckNapi(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "napi_get_cb_info")) return nullptr;
  if (argc < 1) {
    ThrowError(env, "toCPU(handle) expects 1 argument");
    return nullptr;
  }
  DeviceTensor* tensor = nullptr;
  if (!CheckNapi(env, napi_get_value_external(env, argv[0], reinterpret_cast<void**>(&tensor)), "napi_get_value_external")) return nullptr;
  if (!tensor) {
    ThrowError(env, "toCPU received null handle");
    return nullptr;
  }
  std::vector<double> host = CopyToHost(env, tensor);
  return MakeCpuTensorObject(env, tensor->shape, host);
}

napi_value CloneTensor(napi_env env, napi_callback_info info) {
  if (!EnsureDriverReady(env)) return nullptr;
  size_t argc = 1;
  napi_value argv[1];
  if (!CheckNapi(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "napi_get_cb_info")) return nullptr;
  if (argc < 1) {
    ThrowError(env, "cloneTensor(handle) expects 1 argument");
    return nullptr;
  }
  DeviceTensor* tensor = nullptr;
  if (!CheckNapi(env, napi_get_value_external(env, argv[0], reinterpret_cast<void**>(&tensor)), "napi_get_value_external")) return nullptr;
  if (!tensor) {
    ThrowError(env, "cloneTensor received null handle");
    return nullptr;
  }
  DeviceTensor* clone = AllocateTensor(env, tensor->shape);
  if (!clone) return nullptr;
  if (!CopyDeviceToDevice(env, clone, tensor)) {
    TensorFinalizer(env, clone, nullptr);
    return nullptr;
  }
  napi_value obj;
  if (!CheckNapi(env, napi_create_object(env, &obj), "napi_create_object")) return nullptr;
  napi_value handle;
  if (!CheckNapi(env, napi_create_external(env, clone, TensorFinalizer, nullptr, &handle), "napi_create_external")) return nullptr;
  CheckNapi(env, napi_set_named_property(env, obj, "handle", handle), "handle");
  CheckNapi(env, napi_set_named_property(env, obj, "shape", MakeIntArray(env, clone->shape)), "shape");
  CheckNapi(env, napi_set_named_property(env, obj, "device", MakeString(env, kDevice)), "device");
  CheckNapi(env, napi_set_named_property(env, obj, "dtype", MakeString(env, "float64")), "dtype");
  CheckNapi(env, napi_set_named_property(env, obj, "backend", MakeString(env, "cuda")), "backend");
  return obj;
}

napi_value RunTensorOp(napi_env env, napi_callback_info info) {
  if (!EnsureDriverReady(env)) return nullptr;
  size_t argc = 3;
  napi_value argv[3];
  if (!CheckNapi(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "napi_get_cb_info")) return nullptr;
  if (argc < 2) {
    ThrowError(env, "runTensorOp(op, args, options?) expects at least 2 arguments");
    return nullptr;
  }

  std::string op = GetString(env, argv[0]);
  napi_value args_array = argv[1];
  napi_value options;
  if (argc >= 3) options = argv[2];
  else napi_get_undefined(env, &options);

  uint32_t arg_count = 0;
  if (!CheckNapi(env, napi_get_array_length(env, args_array, &arg_count), "napi_get_array_length")) return nullptr;
  std::vector<napi_value> args(arg_count);
  for (uint32_t i = 0; i < arg_count; ++i) {
    if (!CheckNapi(env, napi_get_element(env, args_array, i, &args[i]), "napi_get_element")) return nullptr;
  }

  auto tensor_result = [&](DeviceTensor* out) -> napi_value {
    std::vector<double> host = CopyToHost(env, out);
    return MakeTensorObject(env, out, host);
  };

  auto unary_result = [&](int opcode, double p1 = 0.0, double p2 = 0.0) -> napi_value {
    DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
    if (!a) return nullptr;
    DeviceTensor* out = AllocateTensor(env, a->shape);
    if (!out) return nullptr;
    CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
    CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
    long long n = static_cast<long long>(a->size);
    int op_code = opcode;
    void* params[] = {&a_ptr, &out_ptr, &n, &op_code, &p1, &p2};
    unsigned int blocks = static_cast<unsigned int>((a->size + kThreads - 1) / kThreads);
    if (!Launch(env, "unary_kernel", std::max(1u, blocks), kThreads, params)) {
      TensorFinalizer(env, out, nullptr);
      return nullptr;
    }
    return tensor_result(out);
  };

  auto binary_result = [&](int opcode) -> napi_value {
    DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
    DeviceTensor* b = ParseCudaTensorArg(env, args.at(1));
    if (!a || !b) return nullptr;
    std::vector<int64_t> out_shape;
    if (!BroadcastShape(a->shape, b->shape, &out_shape)) {
      ThrowError(env, "tensor op expects broadcast-compatible cuda tensors");
      return nullptr;
    }
    DeviceTensor* out = AllocateTensor(env, out_shape);
    if (!out) return nullptr;
    CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
    CUdeviceptr b_ptr = reinterpret_cast<CUdeviceptr>(b->data);
    CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
    int a_rank = static_cast<int>(a->shape.size());
    long long a0 = a_rank > 0 ? a->shape[0] : 1;
    long long a1 = a_rank > 1 ? a->shape[1] : 1;
    int b_rank = static_cast<int>(b->shape.size());
    long long b0 = b_rank > 0 ? b->shape[0] : 1;
    long long b1 = b_rank > 1 ? b->shape[1] : 1;
    int out_rank = static_cast<int>(out_shape.size());
    long long o1 = out_rank > 1 ? out_shape[1] : 1;
    long long total = static_cast<long long>(out->size);
    int op_code = opcode;
    void* params[] = {&a_ptr, &b_ptr, &out_ptr, &a_rank, &a0, &a1, &b_rank, &b0, &b1, &out_rank, &o1, &total, &op_code};
    unsigned int blocks = static_cast<unsigned int>((out->size + kThreads - 1) / kThreads);
    if (!Launch(env, "binary_kernel", std::max(1u, blocks), kThreads, params)) {
      TensorFinalizer(env, out, nullptr);
      return nullptr;
    }
    return tensor_result(out);
  };

  try {
    if (op == "fill") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      DeviceTensor* out = AllocateTensor(env, a->shape);
      if (!out) return nullptr;
      double value = GetNumber(env, args.at(1));
      CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
      long long n = static_cast<long long>(out->size);
      void* params[] = {&out_ptr, &n, &value};
      unsigned int blocks = static_cast<unsigned int>((out->size + kThreads - 1) / kThreads);
      if (!Launch(env, "fill_kernel", std::max(1u, blocks), kThreads, params)) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      return tensor_result(out);
    }

    if (op == "get") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      long long index = static_cast<long long>(std::llround(GetNumber(env, args.at(1))));
      if (index < 0 || static_cast<size_t>(index) >= a->size) {
        ThrowError(env, "tensor.get index out of range");
        return nullptr;
      }
      double value = 0.0;
      if (!CheckCuda(env, cudaMemcpy(&value, a->data + index, sizeof(double), cudaMemcpyDeviceToHost), "cudaMemcpyDeviceToHost")) return nullptr;
      return MakeNumber(env, value);
    }

    if (op == "set") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      long long index = static_cast<long long>(std::llround(GetNumber(env, args.at(1))));
      double value = GetNumber(env, args.at(2));
      if (index < 0 || static_cast<size_t>(index) >= a->size) {
        ThrowError(env, "tensor.set index out of range");
        return nullptr;
      }
      DeviceTensor* out = AllocateTensor(env, a->shape);
      if (!out) return nullptr;
      if (!CopyDeviceToDevice(env, out, a)) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      if (!CheckCuda(env, cudaMemcpy(out->data + index, &value, sizeof(double), cudaMemcpyHostToDevice), "cudaMemcpyHostToDevice")) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      return tensor_result(out);
    }

    if (op == "reshape") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      std::vector<int64_t> shape = GetOptionIntArray(env, options, "shape");
      if (Numel(shape) != a->size) {
        ThrowError(env, "tensor.reshape changes tensor size");
        return nullptr;
      }
      DeviceTensor* out = AllocateTensor(env, shape);
      if (!out) return nullptr;
      if (!CopyDeviceToDevice(env, out, a)) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      return tensor_result(out);
    }

    if (op == "unsqueeze" || op == "squeeze") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      std::vector<int64_t> shape = a->shape;
      if (op == "unsqueeze") {
        int axis = static_cast<int>(std::llround(GetOptionNumber(env, options, "axis", 0)));
        int rank = static_cast<int>(shape.size());
        if (axis < 0) axis += rank + 1;
        if (axis < 0 || axis > rank) {
          ThrowError(env, "tensor.unsqueeze axis out of range");
          return nullptr;
        }
        shape.insert(shape.begin() + axis, 1);
      } else {
        bool has_axis = false;
        HasNamedProperty(env, options, "axis", &has_axis);
        if (!has_axis) {
          shape.erase(std::remove(shape.begin(), shape.end(), 1), shape.end());
        } else {
          int axis = NormalizeAxis(static_cast<int>(std::llround(GetOptionNumber(env, options, "axis", 0))), static_cast<int>(shape.size()));
          if (shape[axis] != 1) {
            ThrowError(env, "tensor.squeeze axis must have size 1");
            return nullptr;
          }
          shape.erase(shape.begin() + axis);
        }
        if (shape.empty()) shape.push_back(1);
      }
      DeviceTensor* out = AllocateTensor(env, shape);
      if (!out) return nullptr;
      if (!CopyDeviceToDevice(env, out, a)) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      return tensor_result(out);
    }

    if (op == "transpose") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      if (a->shape.size() != 2) {
        ThrowError(env, "tensor.transpose currently supports rank-2 tensors");
        return nullptr;
      }
      DeviceTensor* out = AllocateTensor(env, {a->shape[1], a->shape[0]});
      if (!out) return nullptr;
      CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
      CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
      long long rows = a->shape[0];
      long long cols = a->shape[1];
      void* params[] = {&a_ptr, &out_ptr, &rows, &cols};
      unsigned int blocks = static_cast<unsigned int>((a->size + kThreads - 1) / kThreads);
      if (!Launch(env, "transpose2d_kernel", std::max(1u, blocks), kThreads, params)) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      return tensor_result(out);
    }

    if (op == "slice_rows") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      if (a->shape.size() != 1 && a->shape.size() != 2) {
        ThrowError(env, "tensor.slice_rows currently supports rank-1 and rank-2 tensors");
        return nullptr;
      }
      long long rows = a->shape[0];
      long long start = static_cast<long long>(std::llround(GetOptionNumber(env, options, "start", 0)));
      long long stop = static_cast<long long>(std::llround(GetOptionNumber(env, options, "stop", static_cast<double>(rows))));
      if (start < 0) start += rows;
      if (stop < 0) stop += rows;
      start = std::clamp<long long>(start, 0, rows);
      stop = std::clamp<long long>(stop, start, rows);
      std::vector<int64_t> out_shape = a->shape.size() == 1 ? std::vector<int64_t>{stop - start} : std::vector<int64_t>{stop - start, a->shape[1]};
      DeviceTensor* out = AllocateTensor(env, out_shape);
      if (!out) return nullptr;
      size_t elem_offset = a->shape.size() == 1 ? static_cast<size_t>(start) : static_cast<size_t>(start * a->shape[1]);
      if (out->size > 0 && !CheckCuda(env, cudaMemcpy(out->data, a->data + elem_offset, out->size * sizeof(double), cudaMemcpyDeviceToDevice), "cudaMemcpyDeviceToDevice")) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      return tensor_result(out);
    }

    if (op == "take_rows") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      if (a->shape.size() != 1 && a->shape.size() != 2) {
        ThrowError(env, "tensor.take_rows currently supports rank-1 and rank-2 tensors");
        return nullptr;
      }
      std::vector<int64_t> indices = GetOptionIntArray(env, options, "indices");
      for (int64_t& idx : indices) {
        if (idx < 0) idx += a->shape[0];
        if (idx < 0 || idx >= a->shape[0]) {
          ThrowError(env, "tensor.take_rows index out of range");
          return nullptr;
        }
      }
      std::vector<int64_t> out_shape = a->shape.size() == 1 ? std::vector<int64_t>{static_cast<int64_t>(indices.size())} : std::vector<int64_t>{static_cast<int64_t>(indices.size()), a->shape[1]};
      DeviceTensor* out = AllocateTensor(env, out_shape);
      if (!out) return nullptr;
      long long* d_indices = nullptr;
      if (!CheckCuda(env, cudaMalloc(reinterpret_cast<void**>(&d_indices), indices.size() * sizeof(long long)), "cudaMalloc indices")) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      if (!CheckCuda(env, cudaMemcpy(d_indices, indices.data(), indices.size() * sizeof(long long), cudaMemcpyHostToDevice), "cudaMemcpyHostToDevice indices")) {
        cudaFree(d_indices);
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
      CUdeviceptr idx_ptr = reinterpret_cast<CUdeviceptr>(d_indices);
      CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
      long long cols = a->shape.size() == 1 ? 1 : a->shape[1];
      long long out_rows = static_cast<long long>(indices.size());
      int rank = static_cast<int>(a->shape.size());
      unsigned int blocks = static_cast<unsigned int>((out->size + kThreads - 1) / kThreads);
      void* params[] = {&a_ptr, &idx_ptr, &out_ptr, &cols, &out_rows, &rank};
      bool ok = Launch(env, "take_rows_kernel", std::max(1u, blocks), kThreads, params);
      cudaFree(d_indices);
      if (!ok) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      return tensor_result(out);
    }

    if (op == "sum") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      DeviceTensor* out = AllocateTensor(env, {1});
      if (!out) return nullptr;
      CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
      CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
      long long n = static_cast<long long>(a->size);
      void* params[] = {&a_ptr, &out_ptr, &n};
      if (!Launch(env, "reduce_sum_kernel", 1, kThreads, params)) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      double result = 0.0;
      if (!CheckCuda(env, cudaMemcpy(&result, out->data, sizeof(double), cudaMemcpyDeviceToHost), "cudaMemcpyDeviceToHost")) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      TensorFinalizer(env, out, nullptr);
      return MakeNumber(env, result);
    }

    if (op == "mean") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      DeviceTensor* out = AllocateTensor(env, {1});
      if (!out) return nullptr;
      CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
      CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
      long long n = static_cast<long long>(a->size);
      void* params[] = {&a_ptr, &out_ptr, &n};
      if (!Launch(env, "reduce_sum_kernel", 1, kThreads, params)) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      double result = 0.0;
      if (!CheckCuda(env, cudaMemcpy(&result, out->data, sizeof(double), cudaMemcpyDeviceToHost), "cudaMemcpyDeviceToHost")) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      TensorFinalizer(env, out, nullptr);
      return MakeNumber(env, result / static_cast<double>(a->size));
    }

    if (op == "sum_axis" || op == "mean_axis" || op == "max_axis") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      int rank = static_cast<int>(a->shape.size());
      int axis = NormalizeAxis(static_cast<int>(std::llround(GetOptionNumber(env, options, "axis", -1))), rank);
      bool keepdim = GetOptionBool(env, options, "keepdim", false);
      if (rank == 1) {
        double value = 0.0;
        if (op == "max_axis") {
          std::vector<double> host = CopyToHost(env, a);
          value = host.empty() ? 0.0 : *std::max_element(host.begin(), host.end());
        } else {
          DeviceTensor* scalar = AllocateTensor(env, {1});
          if (!scalar) return nullptr;
          CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
          CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(scalar->data);
          long long n = static_cast<long long>(a->size);
          void* params[] = {&a_ptr, &out_ptr, &n};
          if (!Launch(env, "reduce_sum_kernel", 1, kThreads, params) || !CheckCuda(env, cudaMemcpy(&value, scalar->data, sizeof(double), cudaMemcpyDeviceToHost), "cudaMemcpyDeviceToHost")) {
            TensorFinalizer(env, scalar, nullptr);
            return nullptr;
          }
          TensorFinalizer(env, scalar, nullptr);
          if (op == "mean_axis") value /= static_cast<double>(a->size);
        }
        DeviceTensor* out = AllocateTensor(env, {1});
        if (!out) return nullptr;
        if (!CheckCuda(env, cudaMemcpy(out->data, &value, sizeof(double), cudaMemcpyHostToDevice), "cudaMemcpyHostToDevice")) {
          TensorFinalizer(env, out, nullptr);
          return nullptr;
        }
        return MakeTensorObject(env, out, {value});
      }
      std::vector<int64_t> out_shape = axis == 0
        ? (keepdim ? std::vector<int64_t>{1, a->shape[1]} : std::vector<int64_t>{a->shape[1]})
        : (keepdim ? std::vector<int64_t>{a->shape[0], 1} : std::vector<int64_t>{a->shape[0]});
      DeviceTensor* out = AllocateTensor(env, out_shape);
      if (!out) return nullptr;
      CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
      CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
      long long rows = a->shape[0];
      long long cols = a->shape[1];
      unsigned int count = static_cast<unsigned int>(axis == 0 ? cols : rows);
      bool ok = false;
      if (op == "max_axis") {
        void* params[] = {&a_ptr, &out_ptr, &rows, &cols, &axis};
        ok = Launch(env, "reduce_axis_max_kernel", std::max(1u, (count + kThreads - 1) / kThreads), kThreads, params);
      } else {
        int mean = op == "mean_axis" ? 1 : 0;
        void* params[] = {&a_ptr, &out_ptr, &rows, &cols, &axis, &mean};
        ok = Launch(env, "reduce_axis_sum_kernel", std::max(1u, (count + kThreads - 1) / kThreads), kThreads, params);
      }
      if (!ok) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      return tensor_result(out);
    }

    if (op == "softmax" || op == "log_softmax") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      if (!a) return nullptr;
      int rank = static_cast<int>(a->shape.size());
      int axis = NormalizeAxis(static_cast<int>(std::llround(GetOptionNumber(env, options, "axis", -1))), rank);
      DeviceTensor* out = AllocateTensor(env, a->shape);
      if (!out) return nullptr;
      CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
      CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
      int log_output = op == "log_softmax" ? 1 : 0;
      bool ok = false;
      if (rank == 1) {
        long long n = a->shape[0];
        void* params[] = {&a_ptr, &out_ptr, &n, &log_output};
        ok = Launch(env, "softmax_rank1_kernel", 1, kThreads, params);
      } else if (rank == 2 && axis == 1) {
        long long rows = a->shape[0];
        long long cols = a->shape[1];
        void* params[] = {&a_ptr, &out_ptr, &rows, &cols, &log_output};
        ok = Launch(env, "softmax_axis1_kernel", static_cast<unsigned int>(rows), kThreads, params);
      } else {
        ThrowError(env, "softmax currently supports rank-1 or rank-2 axis=1 tensors on cuda");
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      if (!ok) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      return tensor_result(out);
    }

    if (op == "bce_loss") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      DeviceTensor* b = ParseCudaTensorArg(env, args.at(1));
      if (!a || !b) return nullptr;
      if (a->shape != b->shape) {
        ThrowError(env, "tensor.bce_loss shape mismatch");
        return nullptr;
      }
      DeviceTensor* out = AllocateTensor(env, {1});
      if (!out) return nullptr;
      double eps = GetOptionNumber(env, options, "eps", 1e-12);
      CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
      CUdeviceptr b_ptr = reinterpret_cast<CUdeviceptr>(b->data);
      CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
      long long n = static_cast<long long>(a->size);
      void* params[] = {&a_ptr, &b_ptr, &out_ptr, &n, &eps};
      if (!Launch(env, "reduce_bce_kernel", 1, kThreads, params)) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      double result = 0.0;
      if (!CheckCuda(env, cudaMemcpy(&result, out->data, sizeof(double), cudaMemcpyDeviceToHost), "cudaMemcpyDeviceToHost")) {
        TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      TensorFinalizer(env, out, nullptr);
      return MakeNumber(env, result);
    }

    if (op == "exp") return unary_result(0);
    if (op == "log") return unary_result(1);
    if (op == "sigmoid") return unary_result(2);
    if (op == "relu") return unary_result(3);
    if (op == "tanh") return unary_result(4);
    if (op == "abs") return unary_result(5);
    if (op == "sqrt") return unary_result(6);
    if (op == "clip") return unary_result(7, GetOptionNumber(env, options, "min", 0.0), GetOptionNumber(env, options, "max", 0.0));

    if (op == "add") return binary_result(0);
    if (op == "sub") return binary_result(1);
    if (op == "mul") return binary_result(2);
    if (op == "div") return binary_result(3);
    if (op == "pow") return binary_result(4);

    if (op == "matmul") {
      DeviceTensor* a = ParseCudaTensorArg(env, args.at(0));
      DeviceTensor* b = ParseCudaTensorArg(env, args.at(1));
      if (!a || !b) return nullptr;
      DeviceTensor* out = nullptr;
      bool ok = false;
      if (a->shape.size() == 1 && b->shape.size() == 1) {
        if (a->shape[0] != b->shape[0]) {
          ThrowError(env, "tensor.matmul vector length mismatch");
          return nullptr;
        }
        out = AllocateTensor(env, {1});
        if (!out) return nullptr;
        CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
        CUdeviceptr b_ptr = reinterpret_cast<CUdeviceptr>(b->data);
        CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
        long long n = a->shape[0];
        void* params[] = {&a_ptr, &b_ptr, &out_ptr, &n};
        ok = Launch(env, "matmul_vv_kernel", 1, kThreads, params);
      } else if (a->shape.size() == 2 && b->shape.size() == 1) {
        if (a->shape[1] != b->shape[0]) {
          ThrowError(env, "tensor.matmul dimension mismatch");
          return nullptr;
        }
        out = AllocateTensor(env, {a->shape[0]});
        if (!out) return nullptr;
        CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
        CUdeviceptr b_ptr = reinterpret_cast<CUdeviceptr>(b->data);
        CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
        long long rows = a->shape[0];
        long long inner = a->shape[1];
        void* params[] = {&a_ptr, &b_ptr, &out_ptr, &rows, &inner};
        ok = Launch(env, "matmul_mv_kernel", static_cast<unsigned int>((rows + kThreads - 1) / kThreads), kThreads, params);
      } else if (a->shape.size() == 1 && b->shape.size() == 2) {
        if (a->shape[0] != b->shape[0]) {
          ThrowError(env, "tensor.matmul dimension mismatch");
          return nullptr;
        }
        out = AllocateTensor(env, {b->shape[1]});
        if (!out) return nullptr;
        CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
        CUdeviceptr b_ptr = reinterpret_cast<CUdeviceptr>(b->data);
        CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
        long long inner = a->shape[0];
        long long cols = b->shape[1];
        void* params[] = {&a_ptr, &b_ptr, &out_ptr, &inner, &cols};
        ok = Launch(env, "matmul_vm_kernel", static_cast<unsigned int>((cols + kThreads - 1) / kThreads), kThreads, params);
      } else if (a->shape.size() == 2 && b->shape.size() == 2) {
        if (a->shape[1] != b->shape[0]) {
          ThrowError(env, "tensor.matmul dimension mismatch");
          return nullptr;
        }
        out = AllocateTensor(env, {a->shape[0], b->shape[1]});
        if (!out) return nullptr;
        CUdeviceptr a_ptr = reinterpret_cast<CUdeviceptr>(a->data);
        CUdeviceptr b_ptr = reinterpret_cast<CUdeviceptr>(b->data);
        CUdeviceptr out_ptr = reinterpret_cast<CUdeviceptr>(out->data);
        long long rows = a->shape[0];
        long long inner = a->shape[1];
        long long cols = b->shape[1];
        void* params[] = {&a_ptr, &b_ptr, &out_ptr, &rows, &inner, &cols};
        ok = Launch(env, "matmul_mm_kernel", static_cast<unsigned int>((out->size + kThreads - 1) / kThreads), kThreads, params);
      } else {
        ThrowError(env, "tensor.matmul currently supports rank-1/rank-2 combinations only");
        return nullptr;
      }
      if (!ok) {
        if (out) TensorFinalizer(env, out, nullptr);
        return nullptr;
      }
      return tensor_result(out);
    }

    ThrowError(env, "Unsupported CUDA tensor op '" + op + "'");
    return nullptr;
  } catch (const std::exception& ex) {
    ThrowError(env, ex.what());
    return nullptr;
  }
}

}  // namespace

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"cudaAvailable", 0, CudaAvailable, 0, 0, 0, napi_default, 0},
      {"deviceCount", 0, DeviceCount, 0, 0, 0, napi_default, 0},
      {"synchronize", 0, Synchronize, 0, 0, 0, napi_default, 0},
      {"createTensor", 0, CreateTensor, 0, 0, 0, napi_default, 0},
      {"toCPU", 0, ToCPU, 0, 0, 0, napi_default, 0},
      {"cloneTensor", 0, CloneTensor, 0, 0, 0, napi_default, 0},
      {"runTensorOp", 0, RunTensorOp, 0, 0, 0, napi_default, 0},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
