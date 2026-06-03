# OpenClaw Fusion 生产部署指南

## 前置要求

- Node.js 18+ 或 Bun 1.0+
- PM2 (`npm install -g pm2`)
- Nginx (推荐) 或 Caddy
- SSL 证书 (Let's Encrypt)

## 1. 环境准备

```bash
# 克隆代码
git clone <repo-url> openclaw-fusion
cd openclaw-fusion

# 安装依赖
bun install

# 创建生产环境配置
cp .env.production.example .env
# 编辑 .env 填入实际值
```

## 2. SSL 证书配置 (Let's Encrypt)

```bash
# 安装 certbot
sudo apt install certbot python3-certbot-nginx

# 申请证书
sudo certbot --nginx -d your-domain.com -d www.your-domain.com

# 自动续期已配置，验证：
sudo certbot renew --dry-run
```

## 3. Nginx 反向代理配置

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256';
    ssl_prefer_server_ciphers on;

    # 安全响应头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # 静态文件缓存
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API 代理
    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }
}
```

## 4. PM2 启动

```bash
# 启动服务
pm2 start ecosystem.config.json --env production

# 保存 PM2 配置
pm2 save

# 设置开机自启
pm2 startup systemd
```

## 5. 日志轮转

```bash
# 安装 logrotate
sudo apt install logrotate

# 创建配置
sudo tee /etc/logrotate.d/openclaw-fusion << 'EOF'
/path/to/openclaw-fusion/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0644 user user
    sharedscripts
    postrotate
        pm2 reload openclaw-fusion
    endscript
}
EOF
```

## 6. 数据库备份

```bash
# 创建备份脚本
tee backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/backups/openclaw"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

cp ./data/agent.db "$BACKUP_DIR/agent_$DATE.db"
# 保留最近 30 天的备份
find $BACKUP_DIR -name "agent_*.db" -mtime +30 -delete
EOF
chmod +x backup.sh

# 添加到 crontab (每天凌晨 3 点)
(crontab -l 2>/dev/null; echo "0 3 * * * /path/to/openclaw-fusion/backup.sh") | crontab -
```

## 7. 监控检查清单

- [ ] `pm2 status` 显示服务运行中
- [ ] `pm2 logs openclaw-fusion` 无错误
- [ ] `curl -H "x-api-key: YOUR_TOKEN" https://your-domain.com/health` 返回 200
- [ ] `curl -H "x-api-key: YOUR_TOKEN" https://your-domain.com/api-keys` 返回 200
- [ ] WebSocket 连接正常 (`wss://your-domain.com`)
- [ ] SSL Labs 评分 A+

## 8. 故障排查

```bash
# 查看日志
pm2 logs openclaw-fusion --lines 100

# 重启服务
pm2 restart openclaw-fusion

# 检查端口占用
lsof -i :18789

# 检查数据库
sqlite3 data/agent.db ".tables"
```
