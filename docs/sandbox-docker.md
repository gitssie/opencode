# Sandbox & Docker 部署说明

## zerobox 沙箱工作原理

opencode 使用 [zerobox](https://github.com/afshinm/zerobox) 对 AI 工具调用进行沙箱隔离。
沙箱通过 `bubblewrap`（bwrap）+ Linux Landlock 实现文件系统和网络访问控制。

### profile

`spawner.ts` 使用 `--profile system-read-linux` 挂载系统只读路径（/bin、/usr、/lib 等），
加上 workspace 的读写权限，以及 `--deny-read /root /home` 防止访问用户凭证。

profile 定义见：`crates/zerobox/profiles/system-read-linux.json`（zerobox 源码仓库）。

---

## Docker 容器运行要求

### 必须加 `--security-opt seccomp=unconfined`

**原因：**

zerobox 在 Linux 上优先使用 user namespace（通过 `unshare --user`）实现沙箱隔离。
Docker 容器默认的 seccomp profile 会阻止 `unshare` 系统调用，导致：

1. `unshare --user` 失败
2. zerobox 退回 **legacy-landlock 模式**（`use_legacy_landlock = true`）
3. `system-read-linux` profile 要求"direct runtime enforcement"，与 legacy-landlock 不兼容
4. 程序 panic：`permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock`

**解决方案：**

```bash
docker run --security-opt seccomp=unconfined -p 4096:4096 opencode:dev
```

完整示例：

```bash
docker run -d \
  --name opencode-serve \
  --security-opt seccomp=unconfined \
  -p 4096:4096 \
  -e OPENCODE_DB_URL='postgresql://user:pass@host:5432/dbname' \
  opencode:dev
```

### zerobox 安装

Dockerfile 从 GitHub Releases 下载预编译二进制：

```dockerfile
ARG ZEROBOX_VERSION=0.3.3
RUN curl -fsSL --retry 3 \
    "https://github.com/afshinm/zerobox/releases/download/v${ZEROBOX_VERSION}/zerobox-x86_64-unknown-linux-gnu.tar.gz" \
    | tar -xz -C /usr/local/bin zerobox \
    && chmod +x /usr/local/bin/zerobox
```

二进制安装在 `/usr/local/bin/zerobox`（非 `/root` 下），这样 `--deny-read /root` 才能生效。

---

## 本机开发（WSL2）

WSL2 本机环境支持 user namespace，zerobox 可直接使用：

```bash
# 安装
curl -fsSL --retry 3 \
  "https://github.com/afshinm/zerobox/releases/download/v0.3.3/zerobox-x86_64-unknown-linux-gnu.tar.gz" \
  | tar -xz -C /usr/local/bin zerobox

# 运行测试
cd packages/opencode && bun test test/sandbox/
```

环境变量 `ZEROBOX_BIN` 可覆盖默认路径 `/usr/local/bin/zerobox`。

---

## 常见错误

| 错误信息 | 原因 | 解决方案 |
|---|---|---|
| `permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock` | 容器内 user namespace 被禁用 | 加 `--security-opt seccomp=unconfined` |
| `bwrap: Can't write data to file /root/.aws: Bad file descriptor` | 使用了 `system-write-linux` profile，`/root/.aws` 是文件而非目录 | 不使用 `system-write-linux`，只用 workspace `--allow-write` |
| `zerobox binary not found` | 未安装 zerobox | 安装到 `/usr/local/bin/zerobox` 或设置 `ZEROBOX_BIN` |
