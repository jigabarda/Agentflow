-- CreateTable
CREATE TABLE "AppInfo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT 'AgentFlow',
    "schemaTag" TEXT NOT NULL DEFAULT 'phase-0',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
