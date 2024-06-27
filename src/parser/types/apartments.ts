export interface MainCharacteristics {
    price: number;
    location: string;
    floor: string;
    number: string;
    photos: string[]
}

export interface Characteristics {
  [key: string]: string;
}

export interface Data {
  link: string;
  characteristics: Characteristics;
  mainCharacteristics: MainCharacteristics;
}