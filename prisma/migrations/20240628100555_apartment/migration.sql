/*
  Warnings:

  - Added the required column `site` to the `Apartment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `Apartment` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Apartment" ADD COLUMN     "site" TEXT NOT NULL,
ADD COLUMN     "type" TEXT NOT NULL;
