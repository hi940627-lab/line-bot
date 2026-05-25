# LINE Bot Webhook for HR System

這是一個簡單的 LINE Bot webhook，用來跟你的 HR 系統整合。

## 環境變數設定

在 Firebase Cloud Functions 的 Runtime settings 裡設定：
- `LINE_CHANNEL_ACCESS_TOKEN` - 你的 Channel Access Token
- `LINE_CHANNEL_SECRET` - 你的 Channel Secret

## 檔案說明

- `functions/package.json` - 依賴套件
- `functions/index.js` - Cloud Function 程式碼
- `.firebaserc` - Firebase 專案設定
- `firebase.json` - Firebase 配置

## 部署步驟

```bash
npm install
firebase deploy --only functions
```
