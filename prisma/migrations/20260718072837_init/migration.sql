-- CreateTable
CREATE TABLE "Sample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "resetCredits" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Window" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sampleId" TEXT NOT NULL,
    "scope" TEXT,
    "window" TEXT NOT NULL,
    "windowSeconds" INTEGER,
    "remainingPercent" REAL,
    "usedPercent" REAL,
    "resetsRaw" TEXT,
    "resetsAt" DATETIME,
    "provider" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    CONSTRAINT "Window_sampleId_fkey" FOREIGN KEY ("sampleId") REFERENCES "Sample" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Sample_provider_observedAt_idx" ON "Sample"("provider", "observedAt");

-- CreateIndex
CREATE INDEX "Window_provider_window_observedAt_idx" ON "Window"("provider", "window", "observedAt");

-- CreateIndex
CREATE INDEX "Window_sampleId_idx" ON "Window"("sampleId");
