-- AlterTable
ALTER TABLE "Run" ADD COLUMN "scheduledFor" DATETIME;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "recurrenceTz" TEXT;
ALTER TABLE "Task" ADD COLUMN "scheduledFor" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "Run_pipelineId_scheduledFor_key" ON "Run"("pipelineId", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "Task_templateId_scheduledFor_key" ON "Task"("templateId", "scheduledFor");

