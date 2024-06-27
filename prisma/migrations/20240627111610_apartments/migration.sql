-- CreateTable
CREATE TABLE "Apartment" (
    "id" SERIAL NOT NULL,
    "link" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "location" TEXT NOT NULL,
    "floor" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "photos" TEXT[],
    "characteristics" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastChecked" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Apartment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Apartment_link_key" ON "Apartment"("link");
