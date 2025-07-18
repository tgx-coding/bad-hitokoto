# 骂人宝典 By Node.js

- 这是一份用Node.js作为后端驱动的骂人宝典,是对[骂人宝典](https://caonima.de)的拙劣模仿
- 本项目提供给[deepdick-public](https://github.com/tgx-coding/deepdick-public)作为一个附加功能，但其本身就可以单独使用

## 项目实例

 [戳这里](https://st.excesama.fun)

 ![图片示例](/example.png)
## 新功能

- 修改参数查询，用法为：http://localhost:3000/api/hitokoto?level=min/max 其中min对应较轻的程度，而max则再进一步
```
- 速率限制与黑名单

## 部署
先决条件: Node.js>= 20.0.0
1. git clone 本项目
```cmd
git clone --depth=1 https://github.com/tgx-coding/bad-hitokoto
```
2. 执行依赖安装
```cmd
npm install
```
3. 启动本项目
```cmd
node index.js
```
- 启动后日志应当如下：
```log
成功连接到SQLite数据库
一言库统计: 总计 1679 条句子
  - max级别: 997 条 (人文类)
  - min级别: 682 条 (天气/时间类)
服务已启动: http://localhost:3000
API地址: http://localhost:3000/api/hitokoto
访问日志将保存到: C:\lennode\xm\caonima\access.log
全局请求限制: 500 次/15分钟
恶意IP检测阈值: 600 次/15分钟请求将被封禁48小时
级别查询示例: /api/hitokoto?level=max
级别查询示例: /api/hitokoto?level=min
```

## 原理&想说的

- 这是使用Node.js移植的骂人宝典，原版采用PHP并更为现代化(~~碎碎念:PHP还现代?~~)
- 项目图一乐，真正想支持还请去看原版

## 许可证

### 本项目采用MIT作为开源许可证