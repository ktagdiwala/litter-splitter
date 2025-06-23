
export enum BinType {
  Landfill = "Landfill",
  Recycle = "Recycle",
  Compost = "Compost",
  NotApplicable = "N/A",
}

export interface IdentifiedObjectInfo {
  objectName: string;
  binType: BinType;
  reason: string;
}
