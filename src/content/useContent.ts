// Type definitions for our content structure
export interface ContentType {
  hero: {
    title: string;
    subtitle: string;
    provider: string;
    service: string;
    transfer: string;
    noGuarantor: string;
  };
  header: {
    navigation: {
      home: string;
      products: string;
      about: string;
      contact: string;
    };
  };
  priceList: {
    title: string;
    description: string;
    headers: {
      productValue: string;
      transferAmount: string;
      firstPayment: string;
      select: string;
    };
    buttons: {
      select: string;
      selected: string;
    };
    selectedValue: {
      title: string;
      productValue: string;
      transferAmount: string;
      firstPayment: string;
    };
  };
  calculator: {
    providerSelection: {
      title: string;
      tabby: string;
      tamara: string;
    };
    firstPayment: {
      title: string;
      yes: string;
      no: string;
    };
    form: {
      customerName: string;
      customerNamePlaceholder: string;
      productValue: string;
      currency: string;
    };
    summary: {
      provider: string;
      firstPaymentStatus: string;
      firstPaymentAmount: string;
      transferAmount: string;
    };
    importantNotes: string;
    orderSummary: {
      name: string;
      amount: string;
      monthlyInstallment: string;
      installmentsCount: string;
    };
    submitButton: string;
    summaryLabels: {
      transferAmountRequired: string;
      monthlyInstallment: string;
      totalInstallments: string;
      monthsCount: string;
    };
    defaultNotes: string;
    validationMessage: string;
    whatsappTemplate: {
      header: string;
      name: string;
      amount: string;
      installmentsCount: string;
      monthlyInstallment: string;
      transferAmount: string;
      monthsUnit: string;
    };
  };
  priceData: Array<{
    productValue: number;
    transferAmount: number;
    firstPayment: number;
  }>;
  features: {
    title: string;
    subtitle: string;
    cards: {
      commitment: {
        title: string;
        description: string;
      };
      security: {
        title: string;
        description: string;
      };
      support: {
        title: string;
        description: string;
      };
    };
  };
  faq: {
    questions: {
      downPayment: {
        question: string;
        answer: string;
      };
      installments: {
        question: string;
        answer: string;
      };
      transfer: {
        question: string;
        answer: string;
      };
    };
  };
  footer: {
    company: {
      name: string;
      description: string;
    };
    quickLinks: {
      title: string;
      home: string;
      products: string;
      howItWorks: string;
      faq: string;
    };
    contact: {
      title: string;
      whatsapp: string;
      phone: string;
      email: string;
      emailAddress: string;
      address: string;
      addressValue: string;
      contactButton: string;
    };
    legal: {
      copyright: string;
      privacy: string;
      terms: string;
    };
  };
  common: {
    currency: string;
    yes: string;
    no: string;
    select: string;
    selected: string;
    name: string;
    amount: string;
    submit: string;
    close: string;
    back: string;
    next: string;
  };
}

"use client";

import { useEffect, useState } from 'react';

// Remote Supabase public URL for content - constructed from environment variable
// Falls back to /api/admin/content if not configured
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const REMOTE_CONTENT_URL = SUPABASE_URL 
  ? `${SUPABASE_URL}/storage/v1/object/public/Content/content.json`
  : '/api/admin/content';

let _cachedContent: ContentType | null = null;
let _cacheTimestamp: number = 0;
const CACHE_DURATION = 5000; // 5 seconds cache duration

async function fetchRemoteContent(): Promise<any> {
  try {
    // Add timestamp to bypass browser cache
    const timestamp = Date.now();
    const res = await fetch(`${REMOTE_CONTENT_URL}?t=${timestamp}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Remote content fetch failed: ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('Failed to fetch remote content.', e);
    return null;
  }
}

// Function to invalidate cache - can be called after updates
export function invalidateContentCache(): void {
  _cachedContent = null;
  _cacheTimestamp = 0;
}

export function useContent(): ContentType {
  const [content, setContent] = useState<ContentType>(() => {
    const now = Date.now();
    const isCacheValid = _cachedContent && (now - _cacheTimestamp) < CACHE_DURATION;
    if (isCacheValid) return _cachedContent as ContentType;
    return getStub();
  });

  useEffect(() => {
    let mounted = true;

    (async () => {
      // Check if cache is still valid
      const now = Date.now();
      const isCacheValid = _cachedContent && (now - _cacheTimestamp) < CACHE_DURATION;
      
      if (isCacheValid) {
        if (mounted) setContent(_cachedContent as ContentType);
        return;
      }

      // Fetch fresh data
      const remote = await fetchRemoteContent();
      if (remote) {
        _cachedContent = remote as ContentType;
        _cacheTimestamp = Date.now();
        if (mounted) setContent(remote as ContentType);
        return;
      }

      // Try dynamic import of local JSON as fallback
      try {
        const mod = await import('./content.json');
        const local = mod?.default ?? mod;
        _cachedContent = local as ContentType;
        _cacheTimestamp = Date.now();
        if (mounted) setContent(local as ContentType);
      } catch (e) {
        // keep stub
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  return content;
}

// Hook to track loading state separately
export function useContentLoading(): boolean {
  const [isLoading, setIsLoading] = useState(() => {
    const now = Date.now();
    const isCacheValid = _cachedContent && (now - _cacheTimestamp) < CACHE_DURATION;
    return !isCacheValid;
  });

  useEffect(() => {
    const now = Date.now();
    const isCacheValid = _cachedContent && (now - _cacheTimestamp) < CACHE_DURATION;
    
    if (isCacheValid) {
      setIsLoading(false);
      return;
    }

    let mounted = true;

    (async () => {
      const remote = await fetchRemoteContent();
      if (remote) {
        _cachedContent = remote as ContentType;
        _cacheTimestamp = Date.now();
        if (mounted) setIsLoading(false);
        return;
      }

      // Try dynamic import of local JSON as fallback
      try {
        const mod = await import('./content.json');
        const local = mod?.default ?? mod;
        _cachedContent = local as ContentType;
        _cacheTimestamp = Date.now();
        if (mounted) setIsLoading(false);
      } catch (e) {
        // Even with stub, stop loading after attempt
        if (mounted) setIsLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  return isLoading;
}

function getStub(): ContentType {
  return {
    hero: { title: '', subtitle: '', provider: '', service: '', transfer: '', noGuarantor: '' },
    header: { navigation: { home: 'Home', products: 'Products', about: 'About', contact: 'Contact' } },
    priceList: {
      title: 'Prices',
      description: '',
      headers: { productValue: 'Product', transferAmount: 'Transfer', firstPayment: 'First', select: 'Select' },
      buttons: { select: 'Select', selected: 'Selected' },
      selectedValue: { title: 'Selected', productValue: 'Product', transferAmount: 'Transfer', firstPayment: 'First' },
    },
    calculator: {
      providerSelection: { title: '', tabby: 'Tabby', tamara: 'Tamara' },
      firstPayment: { title: '', yes: 'Yes', no: 'No' },
      form: { customerName: '', customerNamePlaceholder: '', productValue: '', currency: '' },
      summary: { provider: '', firstPaymentStatus: '', firstPaymentAmount: '', transferAmount: '' },
      importantNotes: '',
      orderSummary: { name: '', amount: '', monthlyInstallment: '', installmentsCount: '' },
      submitButton: '',
      summaryLabels: { transferAmountRequired: '', monthlyInstallment: '', totalInstallments: '', monthsCount: '' },
      defaultNotes: '',
      validationMessage: '',
      whatsappTemplate: { header: '', name: '', amount: '', installmentsCount: '', monthlyInstallment: '', transferAmount: '', monthsUnit: '' },
    },
    priceData: [],
    features: { title: '', subtitle: '', cards: { commitment: { title: '', description: '' }, security: { title: '', description: '' }, support: { title: '', description: '' } } },
    faq: { questions: { downPayment: { question: '', answer: '' }, installments: { question: '', answer: '' }, transfer: { question: '', answer: '' } } },
    footer: { company: { name: '', description: '' }, quickLinks: { title: '', home: '', products: '', howItWorks: '', faq: '' }, contact: { title: '', whatsapp: '', phone: '', email: '', emailAddress: '', address: '', addressValue: '', contactButton: '' }, legal: { copyright: '', privacy: '', terms: '' } },
    common: { currency: '', yes: 'Yes', no: 'No', select: 'Select', selected: 'Selected', name: 'Name', amount: 'Amount', submit: 'Submit', close: 'Close', back: 'Back', next: 'Next' },
  };
}
