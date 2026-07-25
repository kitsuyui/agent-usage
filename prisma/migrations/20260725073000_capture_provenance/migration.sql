ALTER TABLE "Sample" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "Sample" ADD COLUMN "cliVersion" TEXT;

CREATE INDEX "Sample_provider_ok_observedAt_idx"
ON "Sample"("provider", "ok", "observedAt");
