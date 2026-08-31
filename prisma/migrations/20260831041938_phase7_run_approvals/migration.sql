-- CreateTable
CREATE TABLE "RunApproval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "comment" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunApproval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RunApproval_state_idx" ON "RunApproval"("state");

-- CreateIndex
CREATE UNIQUE INDEX "RunApproval_runId_nodeId_key" ON "RunApproval"("runId", "nodeId");
