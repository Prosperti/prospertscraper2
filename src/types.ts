export interface Company {
  id: string;
  name: string;
  industry: string;
  address: string;
  zip: string;
  city: string;
  fullAddress: string;
  phone: string;
  website: string;
  googleMapsLink: string;
  reviewCount: number;
  rating: number;
  status: string;
  source: string;
  analysisStatus?: 'waiting' | 'analyzing' | 'done' | 'error' | '404';
}

export interface AnalyzedCompany extends Company {
  salutation?: string;
  firstName?: string;
  lastName?: string;
  currentPhone?: string;
  email?: string;
  street?: string;
  analyzedZip?: string;
  analyzedCity?: string;
  linkedinUrl?: string;
  logo?: string;
  inhalt?: string;
}
