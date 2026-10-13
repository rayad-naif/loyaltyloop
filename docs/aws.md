# Deploying LoyaltyLoop on AWS

LoyaltyLoop is a plain Node.js (Express) container. It needs **HTTPS**, a **stable public URL**, and a
**Redis database it can reach over HTTPS** (Upstash REST - see note below). Pick one of the options.

> **Redis note:** the storage driver talks to **Upstash's REST API**, so use an Upstash database
> (free tier is fine; pick the region closest to your AWS region). Amazon ElastiCache is *not* reachable
> through that driver. If you must use ElastiCache, you would need to add an `ioredis` driver in `src/store.js`
> (same ~20 methods).

## Option A - AWS App Runner (simplest)

1. **Create an ECR repo and push the image**
   ```bash
   AWS_REGION=us-east-1
   ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   aws ecr create-repository --repository-name loyaltyloop --region $AWS_REGION
   aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com
   docker build -t loyaltyloop .
   docker tag loyaltyloop:latest $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/loyaltyloop:latest
   docker push $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/loyaltyloop:latest
   ```
2. **App Runner -> Create service** -> *Container registry / Amazon ECR* -> choose the image.
   - Port: `3000`
   - Health check: protocol **HTTP**, path **`/health`**
   - CPU/memory: 0.25 vCPU / 0.5 GB is plenty to start.
3. **Environment variables** (see `.env.example`). Put the secrets (`GHL_CLIENT_SECRET`, `GHL_SHARED_SECRET`,
   `TOKEN_ENC_KEY`, `SESSION_SECRET`, `UPSTASH_REDIS_REST_TOKEN`) in **AWS Secrets Manager** and reference them
   as *secrets* in the service configuration instead of plain text.
   Set `APP_BASE_URL` to your final URL (the default `https://xxxx.awsapprunner.com`, or your custom domain).
4. **Custom domain (optional):** App Runner -> *Custom domains* -> add `loyalty.yourdomain.com` and create the
   CNAME/validation records it shows. HTTPS certificates are managed for you.
5. Open `https://<your-url>/health` - every item under `configured` should be `true` and there should be no `warnings`.

Updating: push a new image tag/`latest` and click *Deploy* (or enable automatic deployments from ECR).

## Option B - Elastic Beanstalk (no Docker)

```bash
npm ci --omit=dev
eb init loyaltyloop --platform node.js --region us-east-1
eb create loyaltyloop-prod --single --envvars NODE_ENV=production,APP_BASE_URL=https://loyalty.yourdomain.com
eb setenv GHL_CLIENT_ID=... GHL_CLIENT_SECRET=... GHL_SHARED_SECRET=... GHL_APP_ID=... \
          UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... TOKEN_ENC_KEY=... SESSION_SECRET=...
eb deploy
```
The included `Procfile` (`web: node server.js`) starts the app. Elastic Beanstalk's default proxy forwards port 80
-> the `PORT` it provides, which the app reads automatically. Add an HTTPS listener (ACM certificate) on the
load balancer, and set the health check path to `/health`.

## Option C - ECS Fargate behind an Application Load Balancer

1. Push the image to ECR as in Option A.
2. Create a Fargate task definition (container port `3000`, env vars + Secrets Manager `secrets`), and a service
   behind an ALB with an **HTTPS:443 listener** (ACM certificate) forwarding to a target group
   (protocol HTTP, port 3000, health check `/health`).
3. Point your domain at the ALB (Route 53 alias).
4. Run **2+ tasks** if you like - it is stateless; all state is in Redis. Token refreshes use a Redis lock so
   several instances will not race each other.

## After deployment - HighLevel configuration

Follow *"Configure your HighLevel Marketplace app"* in the main `README.md`, using your final `APP_BASE_URL`.

## Operational notes

- **Webhook latency:** HighLevel expects a quick response. Don't scale to zero (App Runner: keep min instances >= 1).
- **Logs:** stdout/stderr go to CloudWatch automatically on all three options. Search for `[webhook] rejected`
  (bad signatures), `[ghl]` (token problems) and `[points]` (CRM sync failures).
- **Secrets rotation:** `SESSION_SECRET` can be rotated any time (everyone just signs in again).
  `TOKEN_ENC_KEY` **cannot** be changed without users reinstalling, because stored tokens are encrypted with it.
