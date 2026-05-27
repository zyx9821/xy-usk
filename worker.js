// worker.js
import dashboardHTML from "./public/admin.html";
// 【新增】KV与内存双重缓存架构逻辑
let cachedNetworks = null;
let lastNetworkCacheTime = 0;

async function getDynamicNetworks(env) {
    const now = Date.now();
    if (!cachedNetworks || (now - lastNetworkCacheTime > 60000)) {
        const kvData = await env.kv.get("system_networks", "json");
        cachedNetworks = kvData || {
            TRON: { type: 'tron', usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },
            ETH:  { type: 'evm', rpc: 'https://cloudflare-eth.com', usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
            BSC:  { type: 'evm', rpc: 'https://bsc-dataseed.binance.org', usdt: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 }
        };
        lastNetworkCacheTime = now;
    }
    return cachedNetworks;
}
// EVM ERC20 Transfer 事件的 Keccak-256 签名
const EVM_TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // ==========================================
        // 1. 系统初始化与建表 (v1)
        // ==========================================
        const isInit = await env.kv.get("system_init_v1");
        if (!isInit) {
            await env.db.prepare(`CREATE TABLE IF NOT EXISTS orders (
                tx_hash TEXT, network TEXT NOT NULL, amount TEXT NOT NULL,
                from_address TEXT NOT NULL, to_address TEXT, status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (tx_hash, network)
            );`).run();
            // 自动创建 webhooks 表
            await env.db.prepare(`CREATE TABLE IF NOT EXISTS webhooks (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL,
                secret TEXT NOT NULL, binds TEXT DEFAULT '*', icon TEXT, remark TEXT,
                enabled INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );`).run();
                
            // 自动创建 addresses 表 (已解除 UNIQUE 限制支持同地址多节点)
            await env.db.prepare(`CREATE TABLE IF NOT EXISTS addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL,
                icon TEXT, remark TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );`).run();
            // 自动创建 sys_state 表 (用于替代 KV 高频存储区块高度)
            await env.db.prepare(`CREATE TABLE IF NOT EXISTS sys_state (
                key_name TEXT PRIMARY KEY, key_value TEXT
            );`).run();
            // 【重构新增】自动创建 active_watches 表 (用于存储当前活跃的按需监控订单)
            await env.db.prepare(`CREATE TABLE IF NOT EXISTS active_watches (
                address TEXT PRIMARY KEY, network TEXT NOT NULL, expected_amount TEXT NOT NULL,
                order_id TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );`).run();
            await env.kv.put("admin_username", "admin");
            await env.kv.put("admin_password", "123456");
            await env.kv.put("system_init_v1", "true");
        }

        // ==========================================
        // 2. 登录与鉴权路由
        // ==========================================
        if (url.pathname === "/login" && request.method === "POST") {
            const data = await request.formData();
            if (data.get("username") === await env.kv.get("admin_username") && data.get("password") === await env.kv.get("admin_password")) {
                const token = crypto.randomUUID();
                await env.kv.put("admin_token", token, { expirationTtl: 86400 });
                return new Response("Login Success", { status: 302, headers: { "Location": "/dashboard", "Set-Cookie": `token=${token}; HttpOnly; Path=/` } });
            }
            return new Response("账号或密码错误", { status: 401 });
        }
        if (url.pathname === "/") {
            return new Response(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>矩阵控制台登录</title>
    <style>
        body { margin: 0; font-family: system-ui, sans-serif; background: #f3f4f6; display: flex; justify-content: center; align-items: center; height: 100vh; }
        .login-card { background: white; padding: 40px 30px; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.04); width: 100%; max-width: 320px; border: 1px solid #e5e7eb; box-sizing: border-box; }
        .login-card h2 { margin: 0 0 24px; color: #1f2937; font-size: 1.35rem; font-weight: 600; text-align: center; display: flex; justify-content: center; align-items: center; }
        .login-card h2 span { color: #3b82f6; margin-right: 8px; font-size: 1.1rem; }
        .input-group { margin-bottom: 16px; }
        .input-group input { width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; outline: none; transition: 0.2s; box-sizing: border-box; font-size: 0.95rem; background: #f8fafc; }
        .input-group input:focus { border-color: #3b82f6; background: white; box-shadow: 0 0 0 3px rgba(59,130,246,0.15); }
        .login-btn { width: 100%; padding: 12px; background: #3b82f6; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; transition: 0.2s; font-weight: 500; margin-top: 8px; }
        .login-btn:hover { background: #2563eb; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3); }
    </style>
</head>
<body>
    <div class="login-card">
        <h2><span>●</span>夏雨全链矩阵</h2>
        <form action="/login" method="POST">
            <div class="input-group"><input type="text" name="username" placeholder="管理员账号" required></div>
            <div class="input-group"><input type="password" name="password" placeholder="安全密码" required></div>
            <button type="submit" class="login-btn">安全登录</button>
        </form>
    </div>
</body>
</html>`, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
        }

        const cookie = request.headers.get("Cookie") || "";
        const tokenMatch = cookie.match(/token=([^;]+)/);
        if (!tokenMatch || tokenMatch[1] !== await env.kv.get("admin_token")) return new Response("未授权", { status: 302, headers: { "Location": "/" } });

        // ==========================================
        // 3. API 与页面路由
        // ==========================================
        if (url.pathname === "/dashboard") return new Response(dashboardHTML, { headers: { "Content-Type": "text/html;charset=UTF-8" } });

        if (url.pathname === "/api/orders") {
            if (request.method === "GET") {
                const { results } = await env.db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 100").all();
                return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
            }
            if (request.method === "DELETE") {
                const urlObj = new URL(request.url);
                const txHash = urlObj.searchParams.get("tx_hash");
                const network = urlObj.searchParams.get("network");

                // 单条删除判定
                if (txHash && network) {
                    await env.db.prepare("DELETE FROM orders WHERE tx_hash = ? AND network = ?").bind(txHash, network).run();
                    return new Response(JSON.stringify({ success: true }));
                } 
                
                // 批量删除判定
                const body = await request.json();
                if (body && body.items && Array.isArray(body.items)) {
                    for (const item of body.items) {
                        if (item.tx_hash && item.network) {
                            await env.db.prepare("DELETE FROM orders WHERE tx_hash = ? AND network = ?").bind(item.tx_hash, item.network).run();
                        }
                    }
                    return new Response(JSON.stringify({ success: true }));
                }
                return new Response(JSON.stringify({ success: false }), { status: 400 });
            }
        }
        // --- 新增：收款地址 CRUD 接口 ---
        if (url.pathname === "/api/addresses") {
            if (request.method === "GET") {
                const { results } = await env.db.prepare("SELECT * FROM addresses ORDER BY created_at DESC").all();
                return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
            }
            if (request.method === "POST") {
                const data = await request.json();
                const info = await env.db.prepare("INSERT INTO addresses (name, address, icon, remark) VALUES (?, ?, ?, ?)").bind(data.name, data.address, data.icon, data.remark).run();
                return new Response(JSON.stringify({ success: true, id: info.meta.last_row_id }));
            }
            if (request.method === "DELETE") {
                const urlObj = new URL(request.url);
                const id = urlObj.searchParams.get("id");
                await env.db.prepare("DELETE FROM addresses WHERE id = ?").bind(id).run();
                return new Response(JSON.stringify({ success: true }));
            }
            if (request.method === "PUT") {
                const data = await request.json();
                await env.db.prepare("UPDATE addresses SET name=?, address=?, icon=?, remark=? WHERE id=?").bind(data.name, data.address, data.icon, data.remark, data.id).run();
                return new Response(JSON.stringify({ success: true }));
            }
        }

        if (url.pathname === "/api/settings") {
            if (request.method === "POST") {
                const data = await request.json();
                if (data.username) await env.kv.put("admin_username", data.username);
                if (data.password) await env.kv.put("admin_password", data.password);
                if (data.api_secret) await env.kv.put("api_secret", data.api_secret);
                return new Response(JSON.stringify({ success: true }));
            }
            return new Response(JSON.stringify({
                username: await env.kv.get("admin_username"), 
                password: await env.kv.get("admin_password"),
                api_secret: await env.kv.get("api_secret") || ""
            }), { headers: { "Content-Type": "application/json" } });
        }

        if (url.pathname === "/api/webhooks") {
            if (request.method === "GET") {
                const { results } = await env.db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all();
                return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
            }
            if (request.method === "POST") {
                const data = await request.json();
                await env.db.prepare("INSERT INTO webhooks (name, url, secret, binds, icon, remark) VALUES (?, ?, ?, ?, ?, ?)").bind(data.name, data.url, data.secret, data.binds, data.icon, data.remark).run();
                return new Response(JSON.stringify({ success: true }));
            }
            if (request.method === "DELETE") {
                const urlObj = new URL(request.url);
                const id = urlObj.searchParams.get("id");
                await env.db.prepare("DELETE FROM webhooks WHERE id = ?").bind(id).run();
                return new Response(JSON.stringify({ success: true }));
            }
            if (request.method === "PUT") {
                const urlObj = new URL(request.url);
                const id = urlObj.searchParams.get("id");
                const status = urlObj.searchParams.get("status");
                if (status !== null) {
                    await env.db.prepare("UPDATE webhooks SET enabled = ? WHERE id = ?").bind(status === "1" ? 1 : 0, id).run();
                } else {
                    const data = await request.json();
                    await env.db.prepare("UPDATE webhooks SET name=?, url=?, secret=?, binds=?, icon=?, remark=? WHERE id=?").bind(data.name, data.url, data.secret, data.binds, data.icon, data.remark, data.id).run();
                }
                return new Response(JSON.stringify({ success: true }));
            }
        }

        // 【新增】网络节点池动态管理 API
        if (url.pathname === "/api/networks") {
            if (request.method === "GET") {
                return new Response(JSON.stringify(await getDynamicNetworks(env)), { headers: { "Content-Type": "application/json" } });
            }
            if (request.method === "POST") {
                const newNetworks = await request.json();
                await env.kv.put("system_networks", JSON.stringify(newNetworks));
                cachedNetworks = newNetworks; lastNetworkCacheTime = Date.now();
                return new Response(JSON.stringify({ success: true }));
            }
        }
        // 【新增】接收地址精准单链绑定关系的 API
        if (url.pathname === "/api/address-bindings") {
            if (request.method === "GET") {
                const bindings = await env.kv.get("address_to_network", "json") || {};
                return new Response(JSON.stringify(bindings), { headers: { "Content-Type": "application/json" } });
            }
            if (request.method === "POST") {
                const { id, network } = await request.json();
                const bindings = await env.kv.get("address_to_network", "json") || {};
                if (network && network !== "auto") bindings[id.toString()] = network.toUpperCase();
                else delete bindings[id.toString()];
                await env.kv.put("address_to_network", JSON.stringify(bindings));
                return new Response(JSON.stringify({ success: true }));
            }
        }
        // 【重构新增】接收业务端 (xyfk) 发送的按需监控指令 API
        if (url.pathname === "/api/watch" && request.method === "POST") {
            const authHeader = request.headers.get("Authorization");
            const savedSecret = await env.kv.get("api_secret");
            
            // 鉴权拦截：检查通信密钥是否一致
            if (savedSecret && authHeader !== `Bearer ${savedSecret}`) {
                return new Response(JSON.stringify({ success: false, msg: "Unauthorized" }), { status: 401 });
            }

            const { address, network, amount, order_id } = await request.json();
            if (!address || !network || !amount || !order_id) return new Response("Missing params", { status: 400 });

            // 将发卡网传入的地址加入活跃监控队列 (如果该地址在队列中，则更新预期金额与时间)
            await env.db.prepare(
                "INSERT INTO active_watches (address, network, expected_amount, order_id) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET expected_amount = excluded.expected_amount, order_id = excluded.order_id, created_at = CURRENT_TIMESTAMP"
            ).bind(address, network, amount, order_id).run();
            
            return new Response(JSON.stringify({ success: true }));
        }
        // 手动触发全链同步
        if (url.pathname === "/api/sync" && request.method === "POST") {
            await this.syncAllChainsData(env);
            return new Response(JSON.stringify({ success: true }));
        }

        // 如果上方的 API 路由均未匹配，则自动去资源库中寻找对应的静态文件（如 /files/xxx.webp）
        return env.assets.fetch(request);
    },

    // 定时器入口
    async scheduled(event, env, ctx) {
        ctx.waitUntil(this.syncAllChainsData(env));
    },

    // ==========================================
    // 4. 全链并发抓取核心引擎
    // ==========================================
    async syncAllChainsData(env) {
        try {
                // 【重构：垃圾回收】清理超过 30 分钟未支付的失效监控任务，防止队列无限膨胀
                await env.db.prepare("DELETE FROM active_watches WHERE created_at < datetime('now', '-30 minutes')").run();
    
                // 【重构：按需提取】只从 active_watches 提取当前活跃的待支付地址
                const { results } = await env.db.prepare("SELECT address, network FROM active_watches").all();
                if (results.length === 0) return; // 核心防御：无订单交易时，在此处直接 return 休眠，产生 0 次 RPC 网络请求！
    
                const { results: webhooks } = await env.db.prepare("SELECT * FROM webhooks WHERE enabled = 1").all();
                const NETWORKS = await getDynamicNetworks(env);
                const syncTasks = [];
                
                // 按网络将活跃地址分类，极速定位
                const activeTasks = {};
                for (const row of results) {
                    const net = row.network.toUpperCase();
                    if (!activeTasks[net]) activeTasks[net] = [];
                    activeTasks[net].push(row.address);
                }
    
                // 仅对当前有订单产生的那条链进行精确扫块
                for (const [netName, targetAddresses] of Object.entries(activeTasks)) {
                    const netConfig = NETWORKS[netName];
                    if (!netConfig || targetAddresses.length === 0) continue;
                    
                    if (netConfig.type === 'tron') syncTasks.push(this.syncTronNetwork(env, netConfig, targetAddresses, webhooks));
                    else if (netConfig.type === 'evm') syncTasks.push(this.syncEVMNetwork(env, netName, netConfig, targetAddresses, webhooks));
                    else if (netConfig.type === 'aptos') syncTasks.push(this.syncAptosNetwork(env, targetAddresses, webhooks));
                    else if (netConfig.type === 'solana') syncTasks.push(this.syncSolanaNetwork(env, targetAddresses, webhooks));
                    else if (netConfig.type === 'ton') syncTasks.push(this.syncTonNetwork(env, targetAddresses, webhooks));
                }
            }
            // 并发执行所有链的扫块
            await Promise.allSettled(syncTasks);

        } catch (error) {
            console.error("整体引擎运行失败:", error);
        }
    },

    // --- EVM 扫块核心 ---
    async syncEVMNetwork(env, netName, netConfig, addresses, webhooks) {
        try {
            // 获取链上最新区块
            const blockRes = await fetch(netConfig.rpc, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 })
            });
            const blockData = await blockRes.json();
            const latestBlock = parseInt(blockData.result, 16);

            // 改用 D1 数据库读取上次扫描的区块，默认扫前 50 个区块防遗漏
            const stateRow = await env.db.prepare("SELECT key_value FROM sys_state WHERE key_name = ?").bind(`last_block_${netName}`).first();
            let lastCheckBlock = parseInt((stateRow && stateRow.key_value) ? stateRow.key_value : (latestBlock - 50));
            
            // 如果间隔太大（如首次运行），限制最大跨度为 800 个区块，防止公共 RPC 报错
            if (latestBlock - lastCheckBlock > 800) lastCheckBlock = latestBlock - 800;
            if (latestBlock <= lastCheckBlock) return; 

            for (const addr of addresses) {
                const paddedAddr = "0x000000000000000000000000" + addr.replace("0x", "").toLowerCase();
                const payload = {
                    jsonrpc: "2.0", id: 1, method: "eth_getLogs",
                    params: [{
                        fromBlock: "0x" + lastCheckBlock.toString(16),
                        toBlock: "0x" + latestBlock.toString(16),
                        address: netConfig.usdt,
                        topics: [EVM_TRANSFER_SIG, null, paddedAddr]
                    }]
                };

                const rpcRes = await fetch(netConfig.rpc, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
                });
                const logsData = await rpcRes.json();

                if (logsData.result && logsData.result.length > 0) {
                    for (const log of logsData.result) {
                        const txHash = log.transactionHash;
                        const fromAddr = "0x" + log.topics[1].slice(26);
                        const rawAmount = parseInt(log.data, 16);
                        const amountUSDT = (rawAmount / Math.pow(10, netConfig.decimals)).toString();

                        await this.saveAndNotify(env, {
                            network: netName, txHash, amount: amountUSDT, fromAddr, toAddr: addr.toLowerCase(), timestamp: Date.now()
                        }, webhooks);
                    }
                }
            }
            // 改用 D1 数据库的高频更新语句，白嫖每天 10 万次写入额度
            await env.db.prepare("INSERT INTO sys_state (key_name, key_value) VALUES (?, ?) ON CONFLICT(key_name) DO UPDATE SET key_value = excluded.key_value").bind(`last_block_${netName}`, latestBlock.toString()).run();
        } catch (e) { console.error(`${netName} 同步异常:`, e); }
    },

    // --- 波场 TRON 同步核心 ---
    async syncTronNetwork(env, netConfig, addresses, webhooks) {
        const stateRow = await env.db.prepare("SELECT key_value FROM sys_state WHERE key_name = ?").bind("last_check_tron").first();
        let minTimestamp = parseInt((stateRow && stateRow.key_value) ? stateRow.key_value : (Date.now() - 3600000));
        let globalNewestTime = minTimestamp;

        for (const myAddress of addresses) {
            try {
                // 【修正】使用动态传入的 netConfig.usdt，彻底摆脱写死的常量
                const response = await fetch(`https://api.trongrid.io/v1/accounts/${myAddress}/transactions/trc20?contract_address=${netConfig.usdt}&min_timestamp=${minTimestamp}`);
                const json = await response.json();

                if (json.data && json.data.length > 0) {
                    for (const tx of json.data) {
                        if (tx.to === myAddress) {
                            // 金额转换也可以使用动态精度 (波场 USDT 默认是 6)
                            const decimals = netConfig.decimals || 6;
                            const amountUSDT = (parseInt(tx.value) / Math.pow(10, decimals)).toString();
                            
                            await this.saveAndNotify(env, {
                                network: 'TRON', txHash: tx.transaction_id, amount: amountUSDT, fromAddr: tx.from, toAddr: tx.to, timestamp: tx.block_timestamp
                            }, webhooks);
                        }
                        if (tx.block_timestamp > globalNewestTime) globalNewestTime = tx.block_timestamp;
                    }
                }
            } catch (e) { console.error(`TRON 同步异常:`, e); }
        }
        if (globalNewestTime > minTimestamp) {
            await env.db.prepare("INSERT INTO sys_state (key_name, key_value) VALUES (?, ?) ON CONFLICT(key_name) DO UPDATE SET key_value = excluded.key_value").bind("last_check_tron", globalNewestTime.toString()).run();
        }
    },
    // --- 异构公链独立扫块引擎框架 (Aptos, Solana, TON) ---
    async syncAptosNetwork(env, addresses, webhooks) {
        // TODO: 通过 Aptos REST API 拉取对应地址的 0x1::coin::CoinStore<0x...USDT> 的 DepositEvent
        // 扫到之后调用公用方法：await this.saveAndNotify(env, { network: 'APTOS', txHash: ..., amount: ..., fromAddr: ..., toAddr: ..., timestamp: ... }, webhooks);
    },
    async syncSolanaNetwork(env, addresses, webhooks) {
        // TODO: 通过 Solana 的 getSignaturesForAddress 轮询 SPL-Token 转移情况
        // 扫到之后调用公用方法：await this.saveAndNotify(env, txData, webhooks);
    },
    async syncTonNetwork(env, addresses, webhooks) {
        // TODO: 通过 TonCenter API 查询 Jetton (USDT) 的交易历史
        // 扫到之后调用公用方法：await this.saveAndNotify(env, txData, webhooks);
    },

    // --- 数据入库与 Webhook 分发 ---
    async saveAndNotify(env, tx, webhooks) {
        // 尝试入库，利用 UNIQUE 主键防止重复分发
        const dbRes = await env.db.prepare(
            "INSERT OR IGNORE INTO orders (tx_hash, network, amount, from_address, to_address) VALUES (?, ?, ?, ?, ?)"
        ).bind(tx.txHash, tx.network, tx.amount, tx.fromAddr, tx.toAddr).run();

        // 只有首次插入成功 (说明是新订单)，才触发回调
        if (dbRes.meta.changes > 0 && webhooks.length > 0) {
            // 【重构闭环】支付已到账入库，立即将该地址踢出监控队列，停止对该地址的扫块轮询
            await env.db.prepare("DELETE FROM active_watches WHERE address = ?").bind(tx.toAddr).run();
            for (const wh of webhooks) {
                if (!wh.enabled || !wh.url || !wh.secret) continue;
                const bindsRaw = wh.binds.split(',').map(s => s.trim().toLowerCase());
                
                // 核心升级：拦截前端传来的 "地址@@网络" 格式，做到跨链同地址精准隔离推送
                const isMatch = bindsRaw.includes('*') || bindsRaw.some(b => {
                    const parts = b.split('@@');
                    if (parts[0] !== tx.toAddr.toLowerCase()) return false; // 物理地址不匹配，拦截
                    if (parts[1] && parts[1] !== '全网并发' && parts[1] !== tx.network.toLowerCase()) return false; // 链网络不匹配，拦截
                    return true; // 地址和网络全对上，放行
                });
                
                if (isMatch) {
                    // 安全增强：签名中加入 network 防止重放攻击
                    const signText = `${tx.network}${tx.txHash}${tx.amount}${wh.secret}`;
                    const msgBuffer = new TextEncoder().encode(signText);
                    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
                    const signHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

                    fetch(wh.url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            network: tx.network,
                            tx_hash: tx.txHash,
                            amount: tx.amount,
                            from_address: tx.fromAddr,
                            to_address: tx.toAddr,
                            sign: signHex,
                            timestamp: tx.timestamp
                        })
                    }).catch(e => console.error(`[${tx.network}] 分发失败:`, e));
                }
            }
        }
    }
};
