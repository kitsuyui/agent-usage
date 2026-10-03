CREATE TABLE "SamplingControl" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "intervalSeconds" INTEGER NOT NULL,
    "refreshRequestId" TEXT,
    "refreshRequestedAt" DATETIME
);
