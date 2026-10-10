# HTTP 探针通道 —— 本任务的现成代码

> 这份文件是 `dsh_debug_start` 生成的。任务哈希与摄入端点**已经烘死**在下面的代码里，
> 直接复制粘贴即可，不需要你为某种语言再写一个"往文件里追加 JSON"的桩。

- 任务哈希：`{{HASH}}`
- 摄入端点（POST）：`{{ENDPOINT}}`
- 通道状态（GET，自检用）：同一个 URL，`GET` 即可
- 宿主负责写入的日志文件：`{{LOG_PATH}}`

> **路径是固定的，逐字如此**：`POST <宿主地址>/dsh-debug-mode/probe?h={{HASH}}`
> —— 哈希走**查询串** `?h=`，不是路径段。
> 上面那个地址的前半截就是宿主地址；**只有目标不在本机时**（容器里、另一台机器上）
> 才需要把 `127.0.0.1` 换成宿主可达的地址，**路径与哈希一个字都不要动**。

---

## 一、为什么优先走这条路（**先读**）

宿主把写日志这件事**整个接管**了。你只需要"把一条 JSON POST 过去"：

| 你**不需要**做的事 | 谁做 |
| --- | --- |
| 拼字段序（`ts, task, probe, level, msg, data`） | 宿主用 `lib/protocol.js` 重新序列化 |
| 写 `task` 哈希 | 宿主：URL 里的 `h=` 就是真值，**你写了也不算数** |
| 生成时间戳 | 宿主：**省略 `ts` 就补到达时刻**（带时区偏移）。想给**事件时刻**就自己传 `ts`——**批量投递（先攒后发）必须这么干**，否则整个时间序会错位 |
| 截断 8 KiB 单行、数 16 MiB 总量 | 宿主：到顶会写一条 `debug-mode:overflow` 然后停手。**超长值会被裁到刚好放得下**（记录贴近但绝不越过 8 KiB），并标 `truncated: true`、在值里写明省略了多少 |
| 处理并发追加、创建目录、文件权限 | 宿主 |
| 自己挑日志文件路径、自己保证不写脏行 | 宿主 |

因此：**任何能发 HTTP 的语言都是一等公民。** 一个 20 行的"文件桩"实现里最容易出错的那几项
（字段序、时间戳格式、截断、上限、异常吞噬）全都不需要你再写一遍——协议只有一份实现，
就在宿主里。

什么时候**不**用这条路：

- **热路径**（每帧 / 每请求上千次）：HTTP 有往返开销，先在上面加一层"计数 + 每 N 次或每 X ms
  发一条聚合记录"；
- **进程可能硬崩**：HTTP 记录是先发后到，进程崩在半途的记录会丢；
  需要"崩溃前最后几条必须落盘"时，用 Node 文件桩 `{{PROBE_STUB}}`（它同步追加、不缓冲）；
- **根本没有网络栈**：用文件桩。

## 二、先自检，**再**让用户复现

不要等用户复现完才发现通道是死的。`GET` 一下这个端点：

```bash
curl -s '{{ENDPOINT}}'
# {"ok":true,"hash":"{{HASH}}","round":1,"status":"active","logBytes":0,"httpRecords":0}
```

看到 `"ok":true` 就说明"宿主活着 + 任务还在 + 端点认识这个哈希"。
`httpRecords` 是宿主**已经通过这条通道收到过多少条**记录——它是 0 不代表通道坏，
只代表还没有东西发过来。

发一条真实的记录再 GET 一次，`httpRecords` 会 +1 且 `logBytes` 会变大——这才是"通道通了"。

> **shell 被沙箱挡掉、`web_fetch` 又拒绝 `127.0.0.1` 时怎么自检？**
> 用被调试程序自己的语言发一条，**把响应的 body 读出来**（§三 的 Python 片段开了
> `echo=True` 就是干这个的），或者再发一条探针把回执带进日志——回执里的
> `accepted` / `rejected` 与 `dsh_debug_read` 读到的行数互相印证。
> 这条路不依赖任何命令，也不依赖 GET。

## 三、各语言的最小写法

**只有 `probe` 是必填**，其余全部可选。体可以是单个 JSON 对象、对象数组、或 NDJSON（一行一条）。

### curl / shell

```bash
curl -s -X POST '{{ENDPOINT}}' \
  -H 'content-type: text/plain' \
  --data-binary '{"probe":"scripts/run.sh:12:retry","level":"warn","msg":"重试","data":{"attempt":2}}'
```

### Python 3（只用标准库）

```python
# dsh-debug:probe {{HASH}} start
import json
import urllib.request

_DSH_ENDPOINT = "{{ENDPOINT}}"

def probe(name, data=None, level="info", msg=None, echo=False):
    """POST 一条记录，返回宿主回执（失败返回 None）。

    echo=True 时把回执打印出来——这是"通道到底通没通"最省事的自检手段：
    在 shell 被沙箱挡掉、`web_fetch` 又拒绝 `127.0.0.1` 的环境里，它往往是**唯一**的手段。
    回执里的 accepted / rejected 会直接告诉你宿主收下了几条、丢了几条。
    """
    record = {"probe": name, "level": level}
    if msg is not None:
        record["msg"] = msg
    if data is not None:
        record["data"] = data
    try:
        body = json.dumps(record, ensure_ascii=False, default=str).encode("utf-8")
        request = urllib.request.Request(
            _DSH_ENDPOINT, data=body, headers={"content-type": "text/plain;charset=utf-8"}
        )
        with urllib.request.urlopen(request, timeout=0.5) as response:
            receipt = response.read().decode("utf-8", "replace")
        if echo:
            print("[dsh-debug] " + receipt, flush=True)
        return receipt
    except Exception as error:
        if echo:
            print("[dsh-debug] 投递失败：" + str(error), flush=True)
        return None
# dsh-debug:probe {{HASH}} end
```

用的时候：`probe("app/order/service.py:118:resolve-total", {"order_id": order_id}, msg="算总价")`

**别把回执丢掉**（上面的 `with` 块读完了再关，不是 `urlopen(...).close()`）。
宿主回的是 `{"ok":true,"code":200,"accepted":1,"rejected":0,"bytes":137}`：

- `accepted` = **真的落盘了几条**，它涨了才叫"通道通了"；
- `rejected` 涨了说明你的 JSON 有问题（最常见：漏了 `probe`）。

想让"投递成功"这件事进证据链（而不是只在终端上闪一下），就再发一条探针把回执带上：

```python
receipt = probe("app/order/service.py:118:resolve-total", {"order_id": order_id})
probe("app/order/service.py:119:receipt", {"host": receipt})   # 回执进日志，dsh_debug_read 能读到
```

发不出去时回执是 `null`，一眼就能分清"通道问题"与"埋点位置问题"。

### Node.js（≥18，全局 fetch）

```js
// dsh-debug:probe {{HASH}} start
const DSH_ENDPOINT = '{{ENDPOINT}}'
function probe(name, data, options = {}) {
  const body = JSON.stringify({ probe: name, level: options.level ?? 'info', msg: options.msg, data })
  fetch(DSH_ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {})
}
// dsh-debug:probe {{HASH}} end
```

> 这是在**不是 Node 桩**的场合用的（比如另一台机器上的 Node 进程、或不想 import 文件桩时）。

### Ruby

```ruby
# dsh-debug:probe {{HASH}} start
require "net/http"
require "json"
DSH_ENDPOINT = URI("{{ENDPOINT}}")
def probe(name, data = nil, level: "info", msg: nil)
  body = { probe: name, level: level, msg: msg, data: data }.compact.to_json
  Net::HTTP.start(DSH_ENDPOINT.host, DSH_ENDPOINT.port, open_timeout: 0.5, read_timeout: 0.5) do |http|
    http.post(DSH_ENDPOINT, body, { "content-type" => "text/plain" })
  end
rescue StandardError
  nil
end
# dsh-debug:probe {{HASH}} end
```

### Go

```go
// dsh-debug:probe {{HASH}} start
const dshEndpoint = "{{ENDPOINT}}"

func probe(name string, data map[string]any) {
	body, err := json.Marshal(map[string]any{"probe": name, "data": data})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, dshEndpoint, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("content-type", "text/plain")
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
	}
}
// dsh-debug:probe {{HASH}} end
```

### PHP

```php
// dsh-debug:probe {{HASH}} start
const DSH_ENDPOINT = '{{ENDPOINT}}';
function probe(string $name, $data = null, string $level = 'info', ?string $msg = null): void {
    $record = array_filter(['probe' => $name, 'level' => $level, 'msg' => $msg, 'data' => $data], fn($v) => $v !== null);
    $context = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => "content-type: text/plain\r\n",
        'content' => json_encode($record),
        'timeout' => 0.5,
        'ignore_errors' => true,
    ]]);
    @file_get_contents(DSH_ENDPOINT, false, $context);
}
// dsh-debug:probe {{HASH}} end
```

### PowerShell

```powershell
# dsh-debug:probe {{HASH}} start
$DshEndpoint = '{{ENDPOINT}}'
function Write-DshProbe {
    param([string]$Probe, $Data, [string]$Level = 'info', [string]$Msg)
    $record = @{ probe = $Probe; level = $Level }
    if ($Msg) { $record.msg = $Msg }
    if ($null -ne $Data) { $record.data = $Data }
    try {
        Invoke-RestMethod -Method Post -Uri $DshEndpoint -ContentType 'text/plain' `
            -Body ($record | ConvertTo-Json -Compress -Depth 8) -TimeoutSec 1 | Out-Null
    } catch { }
}
# dsh-debug:probe {{HASH}} end
```

### Java（11+）

```java
// dsh-debug:probe {{HASH}} start
static final String DSH_ENDPOINT = "{{ENDPOINT}}";
static final HttpClient DSH_HTTP = HttpClient.newHttpClient();

static void probe(String name, String jsonData) {
    try {
        String body = "{\"probe\":\"" + name + "\",\"data\":" + jsonData + "}";
        HttpRequest request = HttpRequest.newBuilder(URI.create(DSH_ENDPOINT))
            .header("content-type", "text/plain")
            .timeout(Duration.ofMillis(500))
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();
        DSH_HTTP.sendAsync(request, HttpResponse.BodyHandlers.discarding());
    } catch (Exception ignored) {
    }
}
// dsh-debug:probe {{HASH}} end
```

## 四、批量发送（记录多的时候）

一次 POST 可以带**多条**：NDJSON（一行一条）或 JSON 数组。宿主逐条重新序列化，坏记录计数拒绝、
不影响同批的好记录。

```bash
curl -s -X POST '{{ENDPOINT}}' -H 'content-type: text/plain' --data-binary @- <<'EOF'
{"probe":"app.js:10:enter","data":{"id":"A1"}}
{"probe":"app.js:11:branch","data":{"taken":"left"}}
EOF
```

## 五、返回值

成功是 **200** 加一段 JSON（不是 204——204 按 HTTP 规范不许带响应体，
而这段体是投递方**唯一**的自检依据）：

```json
{"ok":true,"code":200,"accepted":2,"rejected":0,"bytes":137}
```

| 字段 | 含义 |
| --- | --- |
| `accepted` | **本次**真的落盘了几条 |
| `rejected` | **本次**因为缺 `probe` 之类被丢掉了几条 |
| `bytes` | **写入后日志文件的总字节数**（不是这一次的增量）——它只增不减，所以"发一条、它变大"就是"通道真的通了"的硬证据 |
| `degraded` | 本次有几条因为超过单行 8 KiB 被**降级**（省略了超长值）。有它说明负载太大，该收窄埋点 |

`code` 是宿主内部的业务码，正常等于 HTTP 状态；异常路径靠 HTTP 状态判断：

- `400` = 体不是可解析的记录；`404` = 哈希不存在（任务已结束？）；`405` = 方法不对；
  `409` = 任务已关闭；`500` = 宿主写盘失败（`reason` 里有原因）；
- 到 16 MiB 上限时 `accepted` 会变成 0 并附一句说明——那时该收窄埋点或开新一轮，
  不要再往里灌。

## 六、约束（宿主强制，你不用管，但别撞）

| 项 | 限制 |
| --- | --- |
| 请求体 | ≤ 64 KiB |
| 单条记录 | **整行**超 8 KiB 时，超长值被裁到**刚好放得下**（记录贴近但绝不越过 8 KiB）；被裁过就标 `truncated: true`，且值里写 `…<省略 N 字符>` |
| 单任务日志总量 | 16 MiB，到顶写一条 `debug-mode:overflow` 后停止接收 |
| 送达语义 | **尽力而为**：发不出去就丢（探针不许拖慢被调试的程序）。所以"日志是空的"要先怀疑投递，再怀疑埋点位置 |
| 顺序 | 按**到达顺序**落盘；宿主补的 `ts` 也是到达时刻（跨进程严格时序不保证）。要保住**事件时刻**就自己传 `ts` |

> ⚠️ **触发线看的是整行，不是你的值。** `ts`/`task`/`probe` 这些字段也要占地方，所以
> "我的值才 8000 字符"不等于安全——实测 8100 字符的值刚好没事，8200 就会触发裁剪。

## 七、想读回一个数字？把它放进**独立的小记录**

`dsh_debug_read` 的**显示层**会把渲染后超过 **240 字符**的 `data` 缩写掉（`…`）。
所以你（或用户）想核对 `accepted` / `bytes` 这类数字时，**不要**把它塞进一条大记录里
——显示缩写会把你要读的数字吃掉（实测就有人这么失手过，白查一轮）。

可靠做法：**每个数字跟一条只含它自己的小记录**（渲染后几十字符，必定完整可见，且与
`⚠️截断` 一眼可分）：

```python
receipt = probe("shop/services.py:118:resolve-total", {"order_id": order_id})
probe("shop/services.py:119:receipt-accepted", {"accepted": 1})    # 只放数字
probe("shop/services.py:120:receipt-bytes", {"bytes": 8192})
```

## 八、排错

| 现象 | 先查什么 |
| --- | --- |
| `GET` 就失败（连不上） | 宿主还在跑吗？端点里的端口/哈希抄对了吗？（这是 `dsh_debug_start` 返回的那个地址） |
| `GET` 返回 `404` | 哈希不属于活跃任务（任务可能已经结束了） |
| `GET` 正常，但发记录后 `httpRecords` 不涨 | 体是不是合法 JSON？`probe` 字段有没有？有没有被 30x 重定向或代理吃掉？ |
| `accepted` 是 0 而 `rejected` > 0 | 记录缺 `probe`（唯一必填字段） |
| 日志里没有你要的那条 | `dsh_debug_read` 看分组计数：桩/调用点根本没执行到，通常是 0 计数 |
