import { z } from 'zod';

const str = z.string().nullish();

export const drmsEquipmentSchema = z.looseObject({
  Id: z.string(),
  Name: str,
  ErpId: str,
  SerialNumber: str,
  ManufacturerName: str,
  ModelName: str,
  ProductName: str,
  Status: str,
  CommunicationType: str,
  CustomerErpId: str,
  CustomerName: str,
  CustomerCsrcId: str,
  RegistrationTime: str,
  InitialConnectionTime: str,
  LastCounterReceivedTime: str,
});

export const drmsCustomerSchema = z.looseObject({
  Id: z.string(),
  Name: str,
  ErpId: str,
  CsrcIds: z.array(z.string()).nullish(),
});

export const drmsCounterSchema = z.looseObject({
  ItemNumber: z.union([z.string(), z.number()]).nullish(),
  Name: z.string(),
  Value: z.union([z.number(), z.string()]).nullish(),
});

export const drmsLatestCountersSchema = z.looseObject({
  Id: str,
  CounterId: z.string(),
  ReceivedTime: str,
  Counters: z.array(drmsCounterSchema).nullish(),
  ModeSizeCounters: z
    .array(z.looseObject({ ColorMode: str, Mode: str, Counters: z.array(drmsCounterSchema).nullish() }))
    .nullish(),
});

export type DrmsEquipment = z.infer<typeof drmsEquipmentSchema>;
export type DrmsCustomer = z.infer<typeof drmsCustomerSchema>;
export type DrmsCounter = z.infer<typeof drmsCounterSchema>;
export type DrmsLatestCounters = z.infer<typeof drmsLatestCountersSchema>;
