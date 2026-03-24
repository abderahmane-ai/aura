import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TensorBackendKind = 'cpu' | 'cuda';
export type TensorDType = 'float64';

export interface NativeTensorData {
    shape: number[];
    values: number[];
    device?: string;
    dtype?: TensorDType;
    backend?: TensorBackendKind;
    handle?: unknown;
}

export interface NativeCudaAddon {
    cudaAvailable(): boolean;
    deviceCount(): number;
    synchronize(): void;
    createTensor(shape: number[], values: number[], device: string): { handle: unknown; shape: number[]; device?: string; dtype?: TensorDType };
    toCPU(handle: unknown): { shape: number[]; values: number[]; device?: string; dtype?: TensorDType };
    cloneTensor(handle: unknown): { handle: unknown; shape?: number[]; device?: string; dtype?: TensorDType };
    runTensorOp(op: string, args: Array<number | string | boolean | NativeTensorData | number[]>, options?: Record<string, unknown>): unknown;
}

let defaultDevice = 'cpu';
let addonLoadAttempted = false;
let addonCache: NativeCudaAddon | null = null;

export function tensorSize(shape: number[]): number {
    let size = 1;
    for (const dim of shape) size *= dim;
    return size;
}

export function makeCpuTensor(shape: number[], values: number[]): NativeTensorData {
    return { shape: [...shape], values: [...values], device: 'cpu', dtype: 'float64', backend: 'cpu' };
}

export function makeTensorData(shape: number[], values: number[], device?: string): NativeTensorData {
    const resolved = normalizeTensorDevice(device ?? defaultDevice);
    if (resolved === 'cpu') return makeCpuTensor(shape, values);
    const addon = requireCudaAddon(`tensor.create(${resolved})`);
    const created = addon.createTensor([...shape], [...values], resolved);
    return {
        shape: [...(created.shape ?? shape)],
        values: [...values],
        device: created.device ?? resolved,
        dtype: created.dtype ?? 'float64',
        backend: 'cuda',
        handle: created.handle,
    };
}

export function tensorMaterializeCPU(data: NativeTensorData, context: string): NativeTensorData {
    if ((data.backend ?? 'cpu') === 'cpu') return makeCpuTensor(data.shape, data.values ?? []);
    const addon = requireCudaAddon(context);
    if (!data.handle) throw new Error(`${context}: cuda tensor missing handle`);
    const host = addon.toCPU(data.handle);
    return makeCpuTensor(host.shape ?? data.shape, host.values ?? data.values);
}

export function cloneTensorData(data: NativeTensorData, context: string): NativeTensorData {
    if ((data.backend ?? 'cpu') === 'cpu') return makeCpuTensor(data.shape, data.values ?? []);
    const addon = requireCudaAddon(context);
    if (!data.handle) throw new Error(`${context}: cuda tensor missing handle`);
    const cloned = addon.cloneTensor(data.handle);
    return {
        shape: [...(cloned.shape ?? data.shape)],
        values: [...data.values],
        device: cloned.device ?? data.device,
        dtype: cloned.dtype ?? data.dtype,
        backend: 'cuda',
        handle: cloned.handle,
    };
}

export function isTensorData(data: unknown): data is NativeTensorData {
    const d = data as NativeTensorData;
    if (typeof d !== 'object' || d === null || !Array.isArray(d.shape)) return false;
    if (!d.shape.every((dim) => Number.isInteger(dim) && dim >= 0)) return false;
    const dtype = d.dtype ?? 'float64';
    const backend = d.backend ?? 'cpu';
    const device = d.device ?? 'cpu';
    if (dtype !== 'float64') return false;
    if (backend !== 'cpu' && backend !== 'cuda') return false;
    if (typeof device !== 'string' || device.length === 0) return false;
    if (!Array.isArray(d.values) || !d.values.every((v) => typeof v === 'number') || tensorSize(d.shape) !== d.values.length) {
        return false;
    }
    if (backend === 'cpu') return true;
    return d.handle !== undefined && d.handle !== null;
}

export function normalizeTensorDevice(device: string): string {
    if (device === 'cpu') return 'cpu';
    if (device === 'cuda' || device === 'cuda:0') return 'cuda:0';
    throw new Error(`Unsupported tensor device '${device}'`);
}

export function tensorDevice(data: NativeTensorData): string {
    return data.device ?? 'cpu';
}

export function tensorIsCuda(data: NativeTensorData): boolean {
    return (data.backend ?? 'cpu') === 'cuda';
}

export function tensorDefaultDevice(): string {
    return defaultDevice;
}

export function setTensorDefaultDevice(device: string): string {
    const normalized = normalizeTensorDevice(device);
    if (normalized !== 'cpu') requireCudaAddon(`tensor.set_default_device(${normalized})`);
    defaultDevice = normalized;
    return defaultDevice;
}

export function cudaAvailable(): boolean {
    const addon = loadCudaAddon();
    if (!addon) return false;
    try {
        return addon.cudaAvailable() === true;
    } catch {
        return false;
    }
}

export function cudaDeviceCount(): number {
    const addon = loadCudaAddon();
    if (!addon) return 0;
    try {
        return addon.deviceCount();
    } catch {
        return 0;
    }
}

export function cudaSynchronize(): void {
    const addon = requireCudaAddon('tensor.synchronize');
    addon.synchronize();
}

export function requireCudaAddon(context: string): NativeCudaAddon {
    const addon = loadCudaAddon();
    if (!addon || addon.cudaAvailable() !== true) {
        throw new Error(`${context}: CUDA backend unavailable`);
    }
    return addon;
}

export function loadCudaAddon(): NativeCudaAddon | null {
    if (addonLoadAttempted) return addonCache;
    addonLoadAttempted = true;
    const require = createRequire(import.meta.url);
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '..', 'native', 'build', 'Release', 'aura_cuda.node'),
        join(here, '..', 'native', 'build', 'Debug', 'aura_cuda.node'),
    ];
    for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        try {
            addonCache = require(candidate) as NativeCudaAddon;
            return addonCache;
        } catch {
            addonCache = null;
        }
    }
    return null;
}
