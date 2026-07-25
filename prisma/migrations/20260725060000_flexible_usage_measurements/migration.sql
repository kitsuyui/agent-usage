-- Add generic measurement fields while preserving existing percent windows.
ALTER TABLE "Window" ADD COLUMN "metric" TEXT NOT NULL DEFAULT 'quota';
ALTER TABLE "Window" ADD COLUMN "unit" TEXT;
ALTER TABLE "Window" ADD COLUMN "value" REAL;
ALTER TABLE "Window" ADD COLUMN "limitValue" REAL;
ALTER TABLE "Window" ADD COLUMN "remainingValue" REAL;
ALTER TABLE "Window" ADD COLUMN "usedValue" REAL;
ALTER TABLE "Window" ADD COLUMN "attributesJson" TEXT;

UPDATE "Window"
SET "unit" = 'percent'
WHERE "remainingPercent" IS NOT NULL OR "usedPercent" IS NOT NULL;

DROP INDEX "Window_provider_window_observedAt_idx";
CREATE INDEX "Window_provider_metric_window_observedAt_idx"
ON "Window"("provider", "metric", "window", "observedAt");

CREATE INDEX "Window_provider_observedAt_idx"
ON "Window"("provider", "observedAt");
