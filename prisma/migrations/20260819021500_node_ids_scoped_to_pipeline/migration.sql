-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PipelineEdge" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "sourceHandle" TEXT,

    PRIMARY KEY ("pipelineId", "id"),
    CONSTRAINT "PipelineEdge_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PipelineEdge" ("id", "pipelineId", "source", "sourceHandle", "target") SELECT "id", "pipelineId", "source", "sourceHandle", "target" FROM "PipelineEdge";
DROP TABLE "PipelineEdge";
ALTER TABLE "new_PipelineEdge" RENAME TO "PipelineEdge";
CREATE INDEX "PipelineEdge_pipelineId_idx" ON "PipelineEdge"("pipelineId");
CREATE TABLE "new_PipelineNode" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "x" REAL NOT NULL,
    "y" REAL NOT NULL,

    PRIMARY KEY ("pipelineId", "id"),
    CONSTRAINT "PipelineNode_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PipelineNode" ("config", "id", "label", "pipelineId", "type", "x", "y") SELECT "config", "id", "label", "pipelineId", "type", "x", "y" FROM "PipelineNode";
DROP TABLE "PipelineNode";
ALTER TABLE "new_PipelineNode" RENAME TO "PipelineNode";
CREATE INDEX "PipelineNode_pipelineId_idx" ON "PipelineNode"("pipelineId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

