// pm2 실행 설정. 사용: npm run build 후 pm2 start ecosystem.config.js
// 환경변수는 Next.js 가 .env.local 에서 읽는다.
module.exports = {
  apps: [
    {
      name: "milesight",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3193",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
    },
  ],
};
