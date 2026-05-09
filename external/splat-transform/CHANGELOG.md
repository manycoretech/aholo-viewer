# ChangeLOG

## 1.2.7

- `ReadTask`支持`maxShDegree`参数

## 1.2.6

- 体素化新增 cpu 实现以及部分算法优化
- 体素化输出格式优化

## 1.2.5

- 修复 SplatData.counts = 0 时构造 lod 异常

## 1.2.4

- 支持生成体素碰撞体
- avif 编解码支持多任务
- 使用 glibc 构建 linux 版本
- 修复小文件生成 lod chunk 失败
- 优化 logger

## 1.2.3

- 优化内部代码，移除无用实现
- 修改 chunk-lod 的 forward box 计算逻辑，匹配业务需求

## 1.2.2

- 添加`libavif`
- 整理文件结构，删除 IData 结构
- 修复 modify 和 chunk-lod 冲突造成删除失败

## 1.2.1

- 支持`GPU`设备选择
- write 支持 MortonSort 用以提升压缩率

## 1.2.0

- 重构 cli 命令
- 底层修改成 pipeline task 支持组合，减少文件保存数量
- 过程计算采用双精度，移除无效代码
- 增加`getOrCreateDevice`用于共享 GPU 设备
- 改进`auto-lod`使其更接近目标值
- 优化输出

## 1.1.2

- 加入 nanogs 检索算法
- 增加 --max-chunk-counts 参数

## 1.1.1

- 优化 lod 参数，防止出现长时间执行

## 1.1.0

- 修改 cli 调用参数
- 优化 lod:auto 时内存无法及时释放导致 oom 的情况
- 新增 lod:auto-chunk 命令
- 多级 lod 支持指数步进
- auto-chunk 优化输出结果

## 1.0.8

- 优化高斯空间分割
- 优化高斯包围盒，移除偏移过大的数据
- 修复`webP`有损编码`quality`读取错误的问题
- 修复 lod 命令异常
- 优化`cluster_average`并行粒度

## 1.0.7

- 支持 SOG 格式输出

## 1.0.6

- 优化 lod 内置参数

## 1.0.5

- 优化 lod 内置参数

## 1.0.4

- 修复`create`解析`deletedIndicesBitMap`异常

## 1.0.3

- 优化`autoLod`效果和实现

## 1.0.2

- 支持流式解析和写入，减少内存占用
- 支持`autoLod`对 3dgs 生成 lod 结果
  - `splat-transform lod --type auto --ratio 0.3 simiao.ply simiao-lod.spz`

## 1.0.1

- 新增`bin.est`防止和`@playcanvas/splat-transform`一起使用时出现冲突

## 1.0.0

- 发包正式包
