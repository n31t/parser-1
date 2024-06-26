export interface MainCharacteristics {
    price: string;
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