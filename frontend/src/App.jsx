import { useState, useEffect, useMemo } from 'react';

// List of all 26 AP Districts for the Sign Up dropdowns
const AP_DISTRICTS = [
  "Alluri Sitharama Raju", "Anakapalli", "Anantapuramu", "Annamayya", "Bapatla", 
  "Chittoor", "East Godavari", "Eluru", "Guntur", "Kakinada", "Konaseema", 
  "Krishna", "Kurnool", "Nandyal", "NTR", "Palnadu", "Parvathipuram Manyam", 
  "Prakasam", "Sri Potti Sriramulu Nellore", "Sri Sathya Sai", "Srikakulam", 
  "Tirupati", "Visakhapatnam", "Vizianagaram", "West Godavari", "YSR Kadapa"
];

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://68.233.97.204:8000';

const getDownloadUrl = (url) => `${API_BASE_URL}/api/download?url=${encodeURIComponent(url)}`;
const getStoredDocumentUrl = (tenderId, index) => `${API_BASE_URL}/api/tenders/${tenderId}/documents/${index}`;

const SORTABLE_COLUMNS = [
  { key: 'department', label: 'Department Name' },
  { key: 'tender_id', label: 'Tender ID' },
  { key: 'tender_notice_number', label: 'Notice Number' },
  { key: 'tender_category', label: 'Category' },
  { key: 'title', label: 'Name of Work' },
  { key: 'est_value', label: 'Estimated Value' },
  { key: 'start_date', label: 'Start Date & Time' },
  { key: 'closing_date', label: 'Closing Date & Time' }
];

const getComparableTenderValue = (tender, key) => {
  const value = tender[key] ?? '';
  const text = String(value).trim();

  if (key === 'tender_id') {
    return Number(text.replace(/\D/g, '')) || 0;
  }

  if (key === 'est_value') {
    return Number(text.replace(/[^\d.]/g, '')) || 0;
  }

  return text.toLowerCase();
};

const isCleanDownloadUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  const lowerUrl = url.toLowerCase().trim();
  return (
    lowerUrl.startsWith('http') &&
    !lowerUrl.endsWith('#') &&
    !lowerUrl.endsWith('.html#')
  );
};

const extractLinksFromText = (value) => {
  if (typeof value !== 'string') return [];

  const links = [];
  const regex = /\[Link:\s*(https?:\/\/[^\]\s]+)\]|(https?:\/\/[^\s\]]+)/gi;
  let match;

  while ((match = regex.exec(value)) !== null) {
    const url = match[1] || match[2];
    if (url && isCleanDownloadUrl(url) && !links.includes(url)) {
      links.push(url);
    }
  }

  return links;
};

const cleanLinkText = (value) => {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\s*\[Link:\s*https?:\/\/[^\]\s]+\]/gi, '')
    .replace(/\s*\[View Details:\s*[^\]]+\]/gi, '')
    .replace(/https?:\/\/[^\s\]]+/gi, '')
    .trim();
};

const extractViewDetailsFromText = (value) => {
  if (typeof value !== 'string') return [];

  const actions = [];
  const regex = /\[View Details:\s*([^\]]+)\]/gi;
  let match;

  while ((match = regex.exec(value)) !== null) {
    const action = match[1]?.trim();
    if (action && !actions.includes(action)) {
      actions.push(action);
    }
  }

  return actions;
};

const collectLinksFromTables = (tables) => {
  if (!Array.isArray(tables)) return [];

  const links = [];
  tables.forEach(table => {
    if (!Array.isArray(table)) return;
    table.forEach(row => {
      if (!Array.isArray(row)) return;
      row.forEach(cell => {
        extractLinksFromText(cell).forEach(url => {
          if (!links.includes(url)) links.push(url);
        });
      });
    });
  });

  return links;
};

const normalizeTenderTables = (rawData) => {
  const parsed = Array.isArray(rawData) ? rawData : JSON.parse(rawData);

  if (!Array.isArray(parsed)) {
    return [];
  }

  const normalized = [];

  parsed.forEach(item => {
    if (typeof item === 'string') {
      try {
        const nested = JSON.parse(item);
        if (Array.isArray(nested)) {
          nested.forEach(table => normalized.push(table));
        }
      } catch {
        normalized.push([[item]]);
      }
    } else {
      normalized.push(item);
    }
  });

  return normalized.filter(table => Array.isArray(table) && table.length > 0);
};

const parseEligibilityCriteria = (tables) => {
  let similarWork = '';
  let solvency = '';
  let bidCapacity = '';
  const quantities = {
    steel: [],
    cc_rcc_vrcc: [],
    earthwork: [],
    gravel: [],
    flooring: [],
    plastering: [],
    wbm_wmm: [],
    bt_ogpc_bm: [],
    etc: []
  };

  if (!Array.isArray(tables)) return { similarWork, solvency, bidCapacity, quantities };

  tables.forEach(table => {
    if (!Array.isArray(table)) return;
    
    table.forEach(row => {
      if (!Array.isArray(row) || row.length === 0) return;
      
      const rowText = row.map(c => typeof c === 'string' ? c.toLowerCase() : '').join(' ');
      
      const isSimilar = rowText.includes('satisfactory completed') || 
                        rowText.includes('similar nature') || 
                        (rowText.includes('prime contractor') && rowText.includes('similar'));
      
      if (isSimilar) {
        const valCell = row.find(cell => typeof cell === 'string' && (cell.includes('Rs:') || cell.toLowerCase().includes('rupees') || cell.toLowerCase().includes('rs :')));
        if (valCell) {
          similarWork = valCell;
        } else if (row.length > 1) {
          similarWork = row[1];
        }
      }

      const isSolvency = rowText.includes('liquid asset') || 
                         rowText.includes('bank solvency') || 
                         rowText.includes('credit facilities');
      if (isSolvency) {
        const valCell = row.find(cell => typeof cell === 'string' && (cell.includes('Rs:') || cell.toLowerCase().includes('rupees') || cell.toLowerCase().includes('rs :')));
        if (valCell) {
          solvency = valCell;
        } else if (row.length > 1) {
          solvency = row[1];
        }
      }

      const isBidCapacity = rowText.includes('bid capacity');
      if (isBidCapacity) {
        const valCell = row.find(cell => typeof cell === 'string' && (cell.includes('Rs:') || cell.toLowerCase().includes('rupees') || cell.toLowerCase().includes('rs :')));
        if (valCell) {
          bidCapacity = valCell;
        } else if (row.length > 1) {
          bidCapacity = row[1];
        }
      }
    });

    let itemColIdx = -1;
    let qtyColIdx = -1;
    let uomColIdx = -1;
    let minQtyColIdx = -1;

    table.forEach((row) => {
      if (!Array.isArray(row)) return;
      const hasItem = row.some(cell => typeof cell === 'string' && cell.toLowerCase().trim() === 'item');
      if (hasItem) {
        row.forEach((cell, cIdx) => {
          if (typeof cell !== 'string') return;
          const lower = cell.toLowerCase().trim();
          if (lower === 'item') itemColIdx = cIdx;
          if (lower.includes('estimated quantity') || (lower.includes('qty') && !lower.includes('minimum'))) qtyColIdx = cIdx;
          if (lower === 'uom') uomColIdx = cIdx;
          if (lower.includes('minimum required quantity') || lower.includes('min') || lower.includes('required quantity')) minQtyColIdx = cIdx;
        });
      }
    });

    if (itemColIdx !== -1) {
      table.forEach((row) => {
        if (!Array.isArray(row) || row.length <= itemColIdx) return;
        const itemName = row[itemColIdx];
        if (!itemName || typeof itemName !== 'string' || itemName.toLowerCase().trim() === 'item' || itemName.toLowerCase().trim() === 'estimated quantity uom minimum required quantity') return;

        let uom = '';
        if (uomColIdx !== -1 && row.length > uomColIdx) {
          uom = row[uomColIdx] || '';
        }
        
        let qty = '';
        if (minQtyColIdx !== -1 && row.length > minQtyColIdx && row[minQtyColIdx]) {
          qty = row[minQtyColIdx];
        } else if (qtyColIdx !== -1 && row.length > qtyColIdx) {
          qty = row[qtyColIdx];
        }

        const lowerName = itemName.toLowerCase().trim();
        const itemObj = { name: itemName, qty, uom };

        const addUniqueItem = (list, item) => {
          const isDuplicate = list.some(existing => 
            existing.name.toLowerCase().trim() === item.name.toLowerCase().trim() && 
            existing.qty === item.qty && 
            existing.uom === item.uom
          );
          if (!isDuplicate) {
            list.push(item);
          }
        };

        if (lowerName.includes('steel') || lowerName.includes('reinforcement')) {
          addUniqueItem(quantities.steel, itemObj);
        } else if (lowerName.includes('concrete') || lowerName.includes('cc') || lowerName.includes('rcc') || lowerName.includes('vrcc') || lowerName.includes('cement')) {
          addUniqueItem(quantities.cc_rcc_vrcc, itemObj);
        } else if (lowerName.includes('earthwork') || lowerName.includes('earth work') || lowerName.includes('excavation')) {
          addUniqueItem(quantities.earthwork, itemObj);
        } else if (lowerName.includes('gravel')) {
          addUniqueItem(quantities.gravel, itemObj);
        } else if (lowerName.includes('flooring')) {
          addUniqueItem(quantities.flooring, itemObj);
        } else if (lowerName.includes('plastering') || lowerName.includes('plaster')) {
          addUniqueItem(quantities.plastering, itemObj);
        } else if (lowerName.includes('wbm') || lowerName.includes('wmm') || lowerName.includes('wet mix') || lowerName.includes('water bound macadam') || lowerName.includes('gsb')) {
          addUniqueItem(quantities.wbm_wmm, itemObj);
        } else if (lowerName.includes('bt') || lowerName.includes('bituminous') || lowerName.includes('ogpc') || lowerName.includes('bm') || lowerName.includes('asphalt') || lowerName.includes('road')) {
          addUniqueItem(quantities.bt_ogpc_bm, itemObj);
        } else {
          if (lowerName && !lowerName.includes('executed the following minimum quantities') && !lowerName.includes('to qualify for award')) {
            addUniqueItem(quantities.etc, itemObj);
          }
        }
      });
    }
  });

  const cleanVal = (val) => {
    if (!val || typeof val !== 'string') return '';
    let cleaned = val.replace(/^Rs:?\s*\(?/gi, '').replace(/^Rs\s*:\s*\(?/gi, '').replace(/\)?$/g, '').trim();
    return cleaned;
  };

  return {
    similarWork: cleanVal(similarWork),
    solvency: cleanVal(solvency),
    bidCapacity: cleanVal(bidCapacity),
    quantities
  };
};

const convertIndianWordsToNumber = (wordStr) => {
  if (!wordStr || typeof wordStr !== 'string') return null;

  const numberMap = {
    'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19,
    'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90
  };

  let cleaned = wordStr.toLowerCase()
    .replace(/rupees/gi, '')
    .replace(/rs\.?/gi, '')
    .replace(/only/gi, '')
    .replace(/,/g, '')
    .replace(/[^a-z0-9\s\.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  let mainPart = cleaned;
  let decimalPart = '';

  const pointIndex = cleaned.indexOf(' point ');
  if (pointIndex !== -1) {
    mainPart = cleaned.substring(0, pointIndex).trim();
    decimalPart = cleaned.substring(pointIndex + 7).trim();
  }

  const parseBlock = (words) => {
    let temp = 0;
    words.forEach(w => {
      if (numberMap[w] !== undefined) {
        temp += numberMap[w];
      } else if (!isNaN(w) && w !== '') {
        temp += parseFloat(w);
      }
    });
    return temp;
  };

  const words = mainPart.split(' ');
  let totalSum = 0;
  let currentBlock = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === 'crore' || word === 'crores') {
      const blockVal = parseBlock(currentBlock);
      totalSum += (blockVal || 1) * 10000000;
      currentBlock = [];
    } else if (word === 'lakh' || word === 'lakhs') {
      const blockVal = parseBlock(currentBlock);
      totalSum += (blockVal || 1) * 100000;
      currentBlock = [];
    } else if (word === 'thousand' || word === 'thousands') {
      const blockVal = parseBlock(currentBlock);
      totalSum += (blockVal || 1) * 1000;
      currentBlock = [];
    } else if (word === 'hundred' || word === 'hundreds') {
      const blockVal = parseBlock(currentBlock);
      totalSum += (blockVal || 1) * 100;
      currentBlock = [];
    } else {
      currentBlock.push(word);
    }
  }

  totalSum += parseBlock(currentBlock);

  let decVal = 0;
  if (decimalPart) {
    const decWords = decimalPart.split(' ');
    let digitStr = '';
    decWords.forEach(w => {
      if (numberMap[w] !== undefined) {
        const num = numberMap[w];
        if (num < 10) {
          digitStr += num.toString();
        } else {
          digitStr += num.toString();
        }
      } else if (!isNaN(w)) {
        digitStr += w;
      }
    });
    if (digitStr) {
      if (digitStr.length === 1) digitStr += '0';
      decVal = parseFloat('0.' + digitStr);
    }
  }

  const finalNum = totalSum + decVal;
  if (finalNum === 0) return null;

  return formatIndianNumber(finalNum);
};

const formatIndianNumber = (num) => {
  const parts = num.toFixed(2).split('.');
  let lastThree = parts[0].substring(parts[0].length - 3);
  const otherParts = parts[0].substring(0, parts[0].length - 3);
  if (otherParts !== '') {
    lastThree = ',' + lastThree;
  }
  const res = otherParts.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + lastThree;
  return '₹ ' + res + (parts[1] !== '00' ? '.' + parts[1] : '');
};

const parseEnquiryFormDetails = (rawData) => {
  if (!rawData) return {};

  try {
    const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const getEnquiryFormRecord = (rawData, formName) => {
  if (!formName) return null;

  const details = parseEnquiryFormDetails(rawData);
  const direct = details[formName];
  if (direct) return direct;

  const normalizedName = formName.toLowerCase().replace(/\s+/g, ' ').trim();
  const matchingKey = Object.keys(details).find(key =>
    key.toLowerCase().replace(/\s+/g, ' ').trim() === normalizedName
  );

  return matchingKey ? details[matchingKey] : null;
};

const getEnquiryFormTables = (record) => {
  if (!record) return [];

  if (Array.isArray(record)) {
    return normalizeTenderTables(record);
  }

  if (record.tables) {
    return normalizeTenderTables(record.tables);
  }

  return [];
};

const getTableText = (table) => (
  Array.isArray(table)
    ? table.flat().join(' ').replace(/\s+/g, ' ').trim().toLowerCase()
    : ''
);

const getRowSignature = (row) => (
  Array.isArray(row)
    ? row.map(cell => String(cell || '').replace(/\s+/g, ' ').trim().toLowerCase()).join('|')
    : ''
);

const isRepeatedBoqContextTable = (table) => {
  const text = getTableText(table);
  const hasTenderSummary = text.includes('current tender details') || text.includes('tender id') || text.includes('name of work');
  const hasSelector = text.includes('select sub work');
  const hasItemColumns = text.includes('s.no') || text.includes('quantity') || text.includes('amount(inr)');

  return (hasTenderSummary || hasSelector) && !hasItemColumns;
};

const isBoqTitleOnlyTable = (table) => {
  const text = getTableText(table);
  return table.length <= 2 && (text === 'boq item details' || text === 'bill of quantity items');
};

const findBoqHeaderIndex = (table) => (
  table.findIndex(row => {
    const signature = getRowSignature(row);
    return (
      signature.includes('s.no') ||
      signature.includes('subwork') ||
      signature.includes('quantity') ||
      signature.includes('amount(inr)')
    );
  })
);

const mergeBoqTables = (tables) => {
  const mergedRows = [];
  const seenRows = new Set();
  let headerRow = null;
  const otherTables = [];

  tables.forEach(table => {
    if (!Array.isArray(table) || table.length === 0) return;
    if (isRepeatedBoqContextTable(table) || isBoqTitleOnlyTable(table)) return;

    const headerIndex = findBoqHeaderIndex(table);

    if (headerIndex === -1) {
      otherTables.push(table);
      return;
    }

    if (!headerRow) {
      headerRow = table[headerIndex];
    }

    table.slice(headerIndex + 1).forEach(row => {
      const signature = getRowSignature(row);
      if (!signature || signature === getRowSignature(headerRow) || seenRows.has(signature)) return;

      seenRows.add(signature);
      mergedRows.push(row);
    });
  });

  if (!headerRow || mergedRows.length === 0) {
    return tables.filter(table => !isRepeatedBoqContextTable(table) && !isBoqTitleOnlyTable(table));
  }

  return [[headerRow, ...mergedRows], ...otherTables];
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const renderTableCellContent = (value, sectionType, options = {}) => {
  const links = sectionType === 'docs' ? extractLinksFromText(value) : [];
  const viewDetails = extractViewDetailsFromText(value);
  const displayText = cleanLinkText(value);

  if (links.length === 0 && viewDetails.length === 0) {
    return displayText || value || '-';
  }

  return (
    <div className="flex flex-col gap-2">
      {displayText && <span>{displayText}</span>}
      <div className="flex flex-wrap gap-2">
        {viewDetails.map((action, idx) => (
          <button
            type="button"
            key={`${action}-${idx}`}
            title={action}
            onClick={options.onViewDetails}
            disabled={!options.onViewDetails}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-50 border border-violet-200 text-violet-700 text-xs font-bold hover:bg-violet-100 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            View Details
          </button>
        ))}
        {links.map((url, idx) => (
          <a
            key={`${url}-${idx}`}
            href={getDownloadUrl(url)}
            download
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-50 border border-amber-200 text-amber-700 text-xs font-bold hover:bg-amber-100 hover:border-amber-300 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
            </svg>
            Download{links.length > 1 ? ` ${idx + 1}` : ''}
          </a>
        ))}
      </div>
    </div>
  );
};

// --- HELPER: Parse and organize raw text blobs into clean Key-Value pairs ---
const formatRawTenderDetails = (rawText) => {
  if (!rawText) return null;
  
  // 1. Remove unwanted button texts from the raw string
  let cleanedText = rawText
      .replace(/Other Links/gi, '')
      .replace(/BOQ Item Details/gi, '')
      .replace(/Tender Documents/gi, '')
      .replace(/Current Tender Details/gi, '')
      .replace(/Enquiry Particulars/gi, '');

  // 2. Define known keys to split the text block by
  const keys = [
      "Tender ID", "Tender Notice Number", "Name of Work", "Tender Category",
      "Tender Type", "Estimated Contract Value\\(INR\\)", "Estimated Contract Value",
      "Submission Closing Date", "Tender Evaluation Type", "Department Name", 
      "Circle/Division", "Name of Project", "Period of Completion/ Delivery Period \\(in months\\)",
      "Period of Completion", "Type of Work", "Bidding Type", "Bid Call \\(Numbers\\)", 
      "Bid Call", "Currency Type", "Default Currency", "Evaluation Criteria", 
      "Form Of Contract", "Consortium/ Joint Venture", "Transaction Fee Details",
      "Transaction Fee Payable to", "IFB No / Tender Notice Number",
      "Tender Details"
  ];

  // 3. Split the text and build a formatted grid
  const regex = new RegExp(`(${keys.join('|')})`, 'g');
  const parts = cleanedText.split(regex);

  const elements = [];
  for (let i = 1; i < parts.length; i += 2) {
      const key = parts[i].replace(/\\/g, ''); // Clean up regex escapes for display
      let value = parts[i+1] ? parts[i+1].trim() : '';
      
      // Clean up trailing dashes or colons
      value = value.replace(/^[-:]\s*/, '');
      
      // Skip empty or redundant headers
      if ((key.trim() === "Tender Details" || key.trim() === "Current Tender Details") && !value) continue;
      if (!value && i + 2 >= parts.length) continue; 
      
      elements.push(
          <div key={i} className="flex flex-col sm:flex-row py-3 border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors px-3 rounded-lg">
              <span className="sm:w-1/3 font-bold text-slate-700 text-sm">{key}</span>
              <span className="sm:w-2/3 text-slate-600 text-sm mt-1 sm:mt-0">{value || '-'}</span>
          </div>
      );
  }

  // Fallback if the text was completely unrecognized
  if (elements.length < 2) {
      return <div className="text-sm text-slate-700 whitespace-pre-wrap p-4 bg-slate-50 rounded-lg border border-slate-200">{cleanedText.trim()}</div>;
  }

  return (
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-1">
          {elements}
      </div>
  );
};

export default function App() {
  // --- AUTHENTICATION STATE ---
  const [currentUser, setCurrentUser] = useState(() => {
    const saved = localStorage.getItem('currentUser');
    return saved ? JSON.parse(saved) : null;
  });
  const [authMode, setAuthMode] = useState('login'); // 'login', 'signup', or 'forgot'
  
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [signupForm, setSignupForm] = useState({ 
    username: '', 
    password: '', 
    phone: '', 
    districts: ['', '', '', ''] 
  });
  const [forgotForm, setForgotForm] = useState({ username: '', phone: '', newPassword: '', confirmPassword: '' });
  const [forgotStep, setForgotStep] = useState(1);
  const [authError, setAuthError] = useState('');
  const [authSuccess, setAuthSuccess] = useState('');

  // --- DASHBOARD STATE ---
  const [tenders, setTenders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchField, setSearchField] = useState('all');
  const [sortConfig, setSortConfig] = useState({ key: 'scraped_at', direction: 'desc' });
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');
  
  // Tab Navigation State (0, 1, 2, 3 for districts, 'more' for everything)
  const [activeTab, setActiveTab] = useState(0); 
  
  // Modal State for Deep Links
  const [activeModal, setActiveModal] = useState({ isOpen: false, type: null, tender: null });
  const [selectedFormDetail, setSelectedFormDetail] = useState(null);
  
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);
  const [notifiedTenders, setNotifiedTenders] = useState(() => {
    const saved = localStorage.getItem('markedTenders');
    return saved ? JSON.parse(saved) : [];
  });

  // --- MODAL HANDLERS (ON-DEMAND DB FETCHING) ---
  const openModal = async (type, tender) => {
    // 1. Open the modal immediately with surface data (will show loading state for deep data)
    setActiveModal({ isOpen: true, type, tender });
    setSelectedFormDetail(null);
    document.body.style.overflow = 'hidden';

    // 2. Fetch the heavy JSON tables from the backend database dynamically
    try {
      const response = await fetch(`${API_BASE_URL}/api/tenders/${tender.tender_id}`);
      if (response.ok) {
        const result = await response.json();
        if (result.status === 'success') {
          // Update modal with the deep data (boq_link, document_link, tender_details)
          setActiveModal(prev => {
            // Prevent race condition if user closed modal before fetch completed
            if (prev.isOpen && prev.tender?.tender_id === tender.tender_id) {
              return { isOpen: true, type, tender: result.data };
            }
            return prev;
          });
        }
      }
    } catch (err) {
      console.error('Failed to fetch deep tender data from database:', err);
    }
  };

  const closeModal = () => {
    setActiveModal({ isOpen: false, type: null, tender: null });
    setSelectedFormDetail(null);
    document.body.style.overflow = 'auto';
  };

  // --- AUTHENTICATION HANDLERS ---
  const handleLogin = (e) => {
    e.preventDefault();
    setAuthError('');
    const users = JSON.parse(localStorage.getItem('users') || '{}');
    const user = users[loginForm.username];
    
    if (user && user.password === loginForm.password) {
      const sessionUser = { username: loginForm.username, districts: user.districts };
      setCurrentUser(sessionUser);
      localStorage.setItem('currentUser', JSON.stringify(sessionUser));
      setActiveTab(0); // Reset to first district on login
    } else {
      setAuthError('Invalid username or password.');
    }
  };

  const handleSignup = (e) => {
    e.preventDefault();
    setAuthError('');
    
    // Validate 10-digit phone number
    const phoneRegex = /^[0-9]{10}$/;
    if (!phoneRegex.test(signupForm.phone)) {
      setAuthError('Please enter a valid 10-digit phone number.');
      return;
    }
    
    // Validate that 4 distinct districts are selected
    const selectedDistricts = signupForm.districts.filter(d => d !== '');
    const uniqueDistricts = new Set(selectedDistricts);
    
    if (uniqueDistricts.size !== 4) {
      setAuthError('Please select 4 distinct priority districts.');
      return;
    }
    
    const users = JSON.parse(localStorage.getItem('users') || '{}');
    if (users[signupForm.username]) {
      setAuthError('Username already exists. Please login.');
      return;
    }
    
    // Save new user with phone
    users[signupForm.username] = { 
      password: signupForm.password, 
      districts: signupForm.districts,
      phone: signupForm.phone
    };
    localStorage.setItem('users', JSON.stringify(users));
    
    // Auto-login after signup
    const sessionUser = { username: signupForm.username, districts: signupForm.districts };
    setCurrentUser(sessionUser);
    localStorage.setItem('currentUser', JSON.stringify(sessionUser));
    setActiveTab(0);
  };

  const handleForgotVerify = (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthSuccess('');
    const users = JSON.parse(localStorage.getItem('users') || '{}');
    const user = users[forgotForm.username];
    
    if (!user) {
      setAuthError('Username does not exist.');
      return;
    }
    if (user.phone !== forgotForm.phone) {
      setAuthError('Phone number does not match this username.');
      return;
    }
    setForgotStep(2);
  };

  const handleForgotReset = (e) => {
    e.preventDefault();
    setAuthError('');
    if (forgotForm.newPassword !== forgotForm.confirmPassword) {
      setAuthError('Passwords do not match.');
      return;
    }
    
    const users = JSON.parse(localStorage.getItem('users') || '{}');
    const user = users[forgotForm.username];
    if (user) {
      user.password = forgotForm.newPassword;
      localStorage.setItem('users', JSON.stringify(users));
      setAuthSuccess('Password reset successful! Please sign in with your new password.');
      setAuthMode('login');
      setLoginForm({ username: forgotForm.username, password: '' });
      setForgotForm({ username: '', phone: '', newPassword: '', confirmPassword: '' });
      setForgotStep(1);
    } else {
      setAuthError('An error occurred. Username not found.');
    }
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setActiveTab(0);
    localStorage.removeItem('currentUser');
  };

  const handleDistrictChange = (index, value) => {
    const newDistricts = [...signupForm.districts];
    newDistricts[index] = value;
    setSignupForm({ ...signupForm, districts: newDistricts });
  };


  // --- APP LOGIC & EFFECTS ---
  useEffect(() => {
    localStorage.setItem('markedTenders', JSON.stringify(notifiedTenders));
  }, [notifiedTenders]);

  useEffect(() => {
    localStorage.setItem('theme', theme);
  }, [theme]);

  // --- PWA INSTALL PROMPT ---
  useEffect(() => {
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setInstallPrompt(e);
    };

    const handleAppInstalled = () => {
      console.log('PWA was installed');
      setInstallPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    console.log(`User response to the install prompt: ${outcome}`);
    setInstallPrompt(null);
  };

  const toggleNotification = (tenderId) => {
    setNotifiedTenders(prev => 
      prev.includes(tenderId) 
        ? prev.filter(id => id !== tenderId) 
        : [...prev, tenderId]
    );
  };

  const toggleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const getActiveBoqTables = () => {
    try {
      const rawData = activeModal.tender?.boq_link;
      if (!rawData || rawData === 'Pending Deep Extraction') return [];
      return mergeBoqTables(normalizeTenderTables(rawData));
    } catch {
      return [];
    }
  };

  const printBoqData = () => {
    const tenderId = activeModal.tender?.tender_id || 'boq';
    const previousTitle = document.title;
    document.title = `${tenderId}_BOQ`;
    window.print();
    setTimeout(() => {
      document.title = previousTitle;
    }, 500);
  };

  const downloadBoqData = () => {
    const tenderId = activeModal.tender?.tender_id || 'boq';
    const title = activeModal.tender?.title || '';
    const tables = getActiveBoqTables();

    if (tables.length === 0) return;

    const tableMarkup = tables.map(table => `
      <table>
        <tbody>
          ${table.map((row, rowIdx) => `
            <tr>
              ${row.map(cell => {
                const tag = rowIdx === 0 ? 'th' : 'td';
                return `<${tag}>${escapeHtml(cleanLinkText(cell) || '-')}</${tag}>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    `).join('');

    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${escapeHtml(tenderId)}_BOQ</title>
          <style>
            body { font-family: Arial, sans-serif; color: #111827; margin: 24px; }
            h1 { font-size: 20px; margin: 0 0 8px; }
            p { margin: 0 0 18px; color: #475569; }
            table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 24px; }
            th, td { border: 1px solid #cbd5e1; padding: 8px; font-size: 12px; vertical-align: top; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
            th { background: #f1f5f9; color: #0f172a; }
          </style>
        </head>
        <body>
          <h1>BOQ Item Details - Tender ${escapeHtml(tenderId)}</h1>
          <p>${escapeHtml(title)}</p>
          ${tableMarkup}
        </body>
      </html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${tenderId}_BOQ.html`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const downloadTenderCsv = (items, scopeLabel) => {
    const rows = Array.isArray(items) ? items : [];
    const columns = [
      ['department', 'Department Name'],
      ['tender_id', 'Tender ID'],
      ['tender_notice_number', 'Notice Number'],
      ['tender_category', 'Category'],
      ['title', 'Name of Work'],
      ['est_value', 'Estimated Value'],
      ['start_date', 'Start Date & Time'],
      ['closing_date', 'Closing Date & Time']
    ];

    const escapeCsv = (value) => {
      const text = String(value ?? '').replace(/\s+/g, ' ').trim();
      return `"${text.replace(/"/g, '""')}"`;
    };

    const csv = [
      columns.map(([, label]) => escapeCsv(label)).join(','),
      ...rows.map(tender => columns.map(([key]) => escapeCsv(tender[key])).join(','))
    ].join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `ap_tenders_${scopeLabel}_${timestamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const buildTenderReportMarkup = (items, title) => {
    const rows = Array.isArray(items) ? items : [];
    const generatedAt = new Date().toLocaleString();

    return `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${escapeHtml(title)}</title>
          <style>
            @page { size: A4 landscape; margin: 12mm; }
            body { font-family: Arial, sans-serif; color: #0f172a; margin: 0; }
            h1 { font-size: 20px; margin: 0 0 4px; }
            .meta { color: #475569; font-size: 12px; margin-bottom: 16px; }
            table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            th, td { border: 1px solid #cbd5e1; padding: 6px; font-size: 10px; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
            th { background: #e2e8f0; color: #0f172a; text-align: left; }
            .id { color: #1d4ed8; font-weight: 700; }
          </style>
        </head>
        <body>
          <h1>${escapeHtml(title)}</h1>
          <div class="meta">Generated: ${escapeHtml(generatedAt)} | Records: ${rows.length}</div>
          <table>
            <thead>
              <tr>
                <th style="width: 13%">Department</th>
                <th style="width: 8%">Tender ID</th>
                <th style="width: 12%">Notice Number</th>
                <th style="width: 8%">Category</th>
                <th style="width: 28%">Name of Work</th>
                <th style="width: 10%">Estimated Value</th>
                <th style="width: 10%">Start Date</th>
                <th style="width: 11%">Closing Date</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(tender => `
                <tr>
                  <td>${escapeHtml(tender.department || 'N/A')}</td>
                  <td class="id">#${escapeHtml(tender.tender_id || 'N/A')}</td>
                  <td>${escapeHtml(tender.tender_notice_number || 'N/A')}</td>
                  <td>${escapeHtml(tender.tender_category || 'N/A')}</td>
                  <td>${escapeHtml(tender.title || 'N/A')}</td>
                  <td>${escapeHtml(tender.est_value || 'N/A')}</td>
                  <td>${escapeHtml(tender.start_date || 'N/A')}</td>
                  <td>${escapeHtml(tender.closing_date || 'N/A')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <script>
            window.onload = function() {
              window.focus();
              window.print();
            };
          </script>
        </body>
      </html>`;
  };

  const downloadTenderPdf = (items, scopeLabel) => {
    const rows = Array.isArray(items) ? items : [];
    if (rows.length === 0) return;

    const title = scopeLabel === 'all' ? 'All AP Tenders' : 'Filtered AP Tenders';
    const reportWindow = window.open('', `ap_tenders_${scopeLabel}_pdf`, 'width=1200,height=800,scrollbars=yes,resizable=yes');

    if (!reportWindow) {
      alert('Please allow popups to open the PDF print window.');
      return;
    }

    reportWindow.document.open();
    reportWindow.document.write(buildTenderReportMarkup(rows, title));
    reportWindow.document.close();
  };

  const buildFormDetailMarkup = (formName, record, tables) => {
    const title = `${formName || 'View Details'} - Tender ${activeModal.tender?.tender_id || ''}`;
    const tableMarkup = tables.length > 0
      ? tables.map(table => `
          <table>
            <tbody>
              ${table.map((row, rowIdx) => `
                <tr>
                  ${row.map(cell => {
                    const tag = rowIdx === 0 ? 'th' : 'td';
                    return `<${tag}>${escapeHtml(cleanLinkText(cell) || '-')}</${tag}>`;
                  }).join('')}
                </tr>
              `).join('')}
            </tbody>
          </table>
        `).join('')
      : `<div class="empty">Details for this row are not scraped yet. Run the 10-tender test scraper and reopen this tender.</div>`;

    return `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${escapeHtml(title)}</title>
          <style>
            body { font-family: Arial, sans-serif; color: #0f172a; margin: 24px; background: #f8fafc; }
            header { margin-bottom: 18px; }
            h1 { font-size: 20px; margin: 0 0 8px; color: #4c1d95; }
            .meta { color: #475569; font-size: 13px; line-height: 1.5; }
            .toolbar { display: flex; gap: 8px; margin: 16px 0; }
            button { border: 0; background: #4f46e5; color: white; border-radius: 6px; padding: 8px 12px; font-weight: 700; cursor: pointer; }
            table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 20px; background: white; }
            th, td { border: 1px solid #cbd5e1; padding: 8px; font-size: 12px; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
            th { background: #ede9fe; color: #312e81; }
            .empty { padding: 18px; border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; border-radius: 8px; }
            @media print {
              body { margin: 12mm; background: white; }
              .toolbar { display: none; }
            }
          </style>
        </head>
        <body>
          <header>
            <h1>${escapeHtml(formName || 'View Details')}</h1>
            <div class="meta">
              Tender ID: #${escapeHtml(activeModal.tender?.tender_id || 'N/A')}<br />
              ${escapeHtml(activeModal.tender?.title || '')}<br />
              ${record?.stage ? `Stage: ${escapeHtml(record.stage)}` : ''}
              ${record?.form_type ? ` | Type: ${escapeHtml(record.form_type)}` : ''}
            </div>
          </header>
          <div class="toolbar">
            <button onclick="window.print()">Download PDF</button>
            <button onclick="window.close()">Close</button>
          </div>
          ${tableMarkup}
        </body>
      </html>`;
  };

  const openFormDetailWindow = (formName) => {
    const record = getEnquiryFormRecord(activeModal.tender?.enquiry_form_details, formName);
    const tables = getEnquiryFormTables(record);
    const detailWindow = window.open('', `tender_${activeModal.tender?.tender_id || 'detail'}_${String(formName || 'view').replace(/\W+/g, '_')}`, 'width=1100,height=760,scrollbars=yes,resizable=yes');

    if (!detailWindow) {
      alert('Please allow popups to open View Details.');
      return;
    }

    detailWindow.document.open();
    detailWindow.document.write(buildFormDetailMarkup(formName, record, tables));
    detailWindow.document.close();
  };

  useEffect(() => {
    if (!currentUser) return; // Only fetch if logged in

    const fetchTenders = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/tenders`);
        if (!response.ok) {
          throw new Error('Failed to connect to the API.');
        }
        const result = await response.json();
        
        if (result.status === 'success') {
          setTenders(result.data);
        } else {
          setError(result.message);
        }
      } catch (err) {
        setError('Cannot connect to backend. Make sure FastAPI (api.py) is running on port 8000!');
      } finally {
        setLoading(false);
      }
    };

    fetchTenders();
    const intervalId = setInterval(fetchTenders, 3600000);
    return () => clearInterval(intervalId);
  }, [currentUser]);

  useEffect(() => {
    if (currentUser && !document.getElementById('google-translate-script')) {
      const addScript = document.createElement('script');
      addScript.id = 'google-translate-script';
      addScript.src = '//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
      addScript.async = true;
      document.body.appendChild(addScript);

      window.googleTranslateElementInit = () => {
        new window.google.translate.TranslateElement(
          {
            pageLanguage: 'en',
            includedLanguages: 'en,te,hi', 
            layout: window.google.translate.TranslateElement.InlineLayout.SIMPLE
          },
          'google_translate_element'
        );
      };
    }
  }, [currentUser]);


  // --- RENDER AUTHENTICATION SCREENS ---
  if (!currentUser) {
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col justify-center items-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
          <div className="bg-slate-900 p-6 text-center">
            <img src="/logo.jpg" alt="Tenders Ravi Logo" className="w-20 h-20 rounded-full mx-auto mb-3 object-cover border-2 border-blue-400 shadow-lg" />
            <h2 className="text-2xl font-bold text-white">AP Tender Hub</h2>
            <p className="text-slate-400 text-sm mt-1">
              {authMode === 'login' ? 'Sign in to your account' : authMode === 'signup' ? 'Create a new account' : 'Reset your password'}
            </p>
          </div>
          
          <div className="p-8">
            {authError && (
              <div className="mb-4 p-3 bg-red-50 text-red-600 border border-red-200 rounded-lg text-sm text-center">
                {authError}
              </div>
            )}
            {authSuccess && (
              <div className="mb-4 p-3 bg-emerald-50 text-emerald-600 border border-emerald-200 rounded-lg text-sm text-center">
                {authSuccess}
              </div>
            )}

            {authMode === 'login' && (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                  <input type="text" required value={loginForm.username} onChange={e => setLoginForm({...loginForm, username: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Enter username" />
                </div>
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="block text-sm font-medium text-slate-700">Password</label>
                    <button type="button" onClick={() => { setAuthMode('forgot'); setForgotStep(1); setAuthError(''); setAuthSuccess(''); }} className="text-xs text-blue-600 font-medium hover:underline">Forgot password?</button>
                  </div>
                  <input type="password" required value={loginForm.password} onChange={e => setLoginForm({...loginForm, password: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="••••••••" />
                </div>
                <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg transition-colors mt-2">Sign In</button>
                <p className="text-center text-sm text-slate-500 mt-4">
                  Don't have an account? <button type="button" onClick={() => {setAuthMode('signup'); setAuthError(''); setAuthSuccess('');}} className="text-blue-600 font-medium hover:underline">Sign up</button>
                </p>
              </form>
            )}
            {authMode === 'signup' && (
              <form onSubmit={handleSignup} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                  <input type="text" required value={signupForm.username} onChange={e => setSignupForm({...signupForm, username: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Choose a username" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
                  <input type="password" required value={signupForm.password} onChange={e => setSignupForm({...signupForm, password: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Create a password" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Phone Number (Linked for password reset)</label>
                  <input type="tel" required value={signupForm.phone || ''} onChange={e => setSignupForm({...signupForm, phone: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="10-digit phone number" pattern="[0-9]{10}" title="Please enter a 10-digit phone number" />
                </div>
                
                <div className="pt-3 border-t border-slate-100">
                  <label className="block text-sm font-bold text-slate-800 mb-2">Select 4 Priority Districts</label>
                  <p className="text-xs text-slate-500 mb-3">Your dashboard will initially filter tenders based on these areas.</p>
                  <div className="grid grid-cols-2 gap-3">
                    {[0, 1, 2, 3].map(index => (
                      <select 
                        key={index} 
                        required 
                        value={signupForm.districts[index]} 
                        onChange={e => handleDistrictChange(index, e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none bg-slate-50"
                      >
                        <option value="" disabled>District {index + 1}</option>
                        {AP_DISTRICTS.map(district => (
                          <option key={district} value={district}>{district}</option>
                        ))}
                      </select>
                    ))}
                  </div>
                </div>

                <button type="submit" className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-2.5 rounded-lg transition-colors mt-4">Create Account</button>
                <p className="text-center text-sm text-slate-500 mt-4">
                  Already have an account? <button type="button" onClick={() => {setAuthMode('login'); setAuthError(''); setAuthSuccess('');}} className="text-blue-600 font-medium hover:underline">Sign in</button>
                </p>
              </form>
            )}
            {authMode === 'forgot' && (
              <form onSubmit={forgotStep === 1 ? handleForgotVerify : handleForgotReset} className="space-y-4">
                {forgotStep === 1 ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                      <input type="text" required value={forgotForm.username} onChange={e => setForgotForm({...forgotForm, username: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Enter username" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Linked Phone Number</label>
                      <input type="tel" required value={forgotForm.phone} onChange={e => setForgotForm({...forgotForm, phone: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Enter 10-digit phone number" pattern="[0-9]{10}" />
                    </div>
                    <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg transition-colors mt-2">Verify Details</button>
                  </>
                ) : (
                  <>
                    <div className="bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg p-3 text-xs mb-2">
                      Details verified! Enter your new password below.
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">New Password</label>
                      <input type="password" required value={forgotForm.newPassword} onChange={e => setForgotForm({...forgotForm, newPassword: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="New password" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Confirm New Password</label>
                      <input type="password" required value={forgotForm.confirmPassword} onChange={e => setForgotForm({...forgotForm, confirmPassword: e.target.value})} className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none" placeholder="Confirm new password" />
                    </div>
                    <button type="submit" className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-2.5 rounded-lg transition-colors mt-2">Reset Password</button>
                  </>
                )}
                <p className="text-center text-sm text-slate-500 mt-4">
                  Back to <button type="button" onClick={() => { setAuthMode('login'); setAuthError(''); setAuthSuccess(''); }} className="text-blue-600 font-medium hover:underline">Sign in</button>
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- DASHBOARD FILTERING LOGIC ---

  // Reset pagination when search or tab changes
  useEffect(() => {
    setCurrentPage(1);
  }, [activeTab, searchTerm, searchField, itemsPerPage]);

  // 1. Memoize displayTenders to prevent heavy recalculations & sorting on every render
  const displayTenders = useMemo(() => {
    const searchValue = searchTerm.toLowerCase().trim();
    
    // First, apply text search filter
    const searched = tenders.filter(tender => {
      if (!searchValue) return true;

      const searchableFields = {
        all: [
          tender.title,
          tender.tender_id,
          tender.tender_notice_number,
          tender.department,
          tender.tender_category,
          tender.est_value
        ],
        title: [tender.title],
        tender_id: [tender.tender_id],
        tender_notice_number: [tender.tender_notice_number],
        department: [tender.department]
      };

      return (searchableFields[searchField] || searchableFields.all)
        .some(value => String(value || '').toLowerCase().includes(searchValue));
    });

    // Second, apply district tab filter
    let filteredList = [];
    if (activeTab === 'more') {
      filteredList = searched;
    } else {
      const currentDistrict = currentUser?.districts?.[activeTab];
      if (!currentDistrict) {
        filteredList = searched;
      } else {
        const lowerDistrict = currentDistrict.toLowerCase();
        filteredList = searched.filter(tender => 
          (tender.department && tender.department.toLowerCase().includes(lowerDistrict)) ||
          (tender.title && tender.title.toLowerCase().includes(lowerDistrict)) ||
          (tender.tender_notice_number && tender.tender_notice_number.toLowerCase().includes(lowerDistrict))
        );
      }
    }

    // Third, apply sorting
    return [...filteredList].sort((a, b) => {
      const aValue = getComparableTenderValue(a, sortConfig.key);
      const bValue = getComparableTenderValue(b, sortConfig.key);

      if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [tenders, searchTerm, searchField, activeTab, sortConfig, currentUser]);

  // Derived tab title
  const tabTitle = useMemo(() => {
    if (activeTab === 'more') return "All State Tenders";
    const currentDistrict = currentUser?.districts?.[activeTab];
    return currentDistrict ? `${currentDistrict} Tenders` : "Tenders";
  }, [activeTab, currentUser]);

  // Memoize marked tenders list
  const markedTendersList = useMemo(() => {
    return tenders.filter(t => notifiedTenders.includes(t.tender_id));
  }, [tenders, notifiedTenders]);

  // Get slice for the current page to display
  const paginatedTenders = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return displayTenders.slice(startIndex, startIndex + itemsPerPage);
  }, [displayTenders, currentPage, itemsPerPage]);

  const SortableHeader = ({ column }) => {
    const isActive = sortConfig.key === column.key;
    const directionLabel = isActive ? (sortConfig.direction === 'asc' ? 'Ascending' : 'Descending') : 'Sort';

    return (
      <button
        type="button"
        onClick={() => toggleSort(column.key)}
        className="inline-flex items-center gap-1.5 font-medium hover:text-blue-700 transition-colors"
        title={`${directionLabel} by ${column.label}`}
      >
        <span>{column.label}</span>
        <svg className={`w-3.5 h-3.5 ${isActive ? 'text-blue-600' : 'text-slate-300'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {isActive && sortConfig.direction === 'asc' ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 15l7-7 7 7" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          )}
        </svg>
      </button>
    );
  };

  const renderSidebarContents = () => (
    <>
      <div className="p-6 flex items-center justify-between border-b border-slate-700">
        <div className="flex items-center gap-3">
          <img src="/logo.jpg" alt="Tenders Ravi Logo" className="w-8 h-8 rounded-full object-cover border border-blue-400 shadow-sm" />
          <h1 className="text-xl font-bold tracking-wide">AP Tender Hub</h1>
        </div>
        {/* Close button inside mobile sidebar */}
        <button
          onClick={() => setIsMobileSidebarOpen(false)}
          className="lg:hidden p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white"
          aria-label="Close menu"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      
      {/* User Profile Area */}
      <div className="px-6 py-4 bg-slate-800/50">
        <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Logged in as</p>
        <div className="flex justify-between items-center">
          <p className="font-bold text-white truncate pr-2">@{currentUser.username}</p>
          <button onClick={handleLogout} className="text-xs text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded transition-colors">
            Logout
          </button>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-2 mt-2">
        <a href="#" className="flex items-center gap-3 p-3 bg-blue-600 rounded-lg text-white font-medium transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"></path></svg>
          <span>Dashboard</span>
        </a>
      </nav>

      {/* PWA Install Button */}
      {installPrompt && (
        <div className="p-4 border-t border-slate-700/80">
          <button
            onClick={handleInstallClick}
            className="w-full flex items-center justify-center gap-2 p-3 bg-emerald-600 hover:bg-emerald-700 rounded-lg text-white font-bold transition-all shadow-md active:scale-95"
            aria-label="Install AP Tender Hub App"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span>Install App</span>
          </button>
        </div>
      )}
    </>
  );

  return (
    <div className={`flex h-screen font-sans overflow-hidden relative ${theme === 'dark' ? 'dark-theme bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-800'}`}>
      
      {/* Custom Styles for Google Translate */}
      <style>{`
        .goog-te-banner-frame { display: none !important; }
        body { top: 0px !important; }
        .goog-te-gadget-simple { 
          background-color: #f8fafc !important; 
          border: 1px solid #cbd5e1 !important; 
          border-radius: 0.5rem !important; 
          padding: 0.5rem 1rem !important; 
          font-size: 0.875rem !important; 
          font-family: inherit !important;
        }
        .goog-te-gadget-icon { display: none !important; }
        .goog-te-menu-value span { color: #1e293b !important; font-weight: 500 !important; }
        .dark-theme .theme-surface { background-color: #0f172a !important; border-color: #334155 !important; color: #e2e8f0 !important; }
        .dark-theme .theme-panel { background-color: #111827 !important; border-color: #334155 !important; color: #e5e7eb !important; }
        .dark-theme .theme-muted { color: #94a3b8 !important; }
        .dark-theme .theme-heading { color: #f8fafc !important; }
        .dark-theme .theme-soft { background-color: #1e293b !important; border-color: #334155 !important; }
        .dark-theme header,
        .dark-theme main,
        .dark-theme .bg-white,
        .dark-theme .bg-slate-50,
        .dark-theme .bg-slate-100 {
          background-color: #0f172a !important;
          border-color: #334155 !important;
          color: #e2e8f0 !important;
        }
        .dark-theme .text-slate-800,
        .dark-theme .text-slate-700,
        .dark-theme .text-slate-600 {
          color: #e2e8f0 !important;
        }
        .dark-theme .text-slate-500,
        .dark-theme .text-slate-400 {
          color: #94a3b8 !important;
        }
        .dark-theme input,
        .dark-theme select {
          background-color: #020617 !important;
          border-color: #475569 !important;
          color: #f8fafc !important;
        }
        .dark-theme tr.hover\\:bg-slate-50:hover {
          background-color: #1e293b !important;
        }
        @media print {
          body * { visibility: hidden !important; }
          #boq-print-area, #boq-print-area * { visibility: visible !important; }
          #boq-print-area {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            background: white !important;
            color: black !important;
          }
          #boq-print-area table {
            width: 100% !important;
            table-layout: fixed !important;
            border-collapse: collapse !important;
          }
          #boq-print-area th,
          #boq-print-area td {
            white-space: normal !important;
            overflow-wrap: anywhere !important;
            word-break: break-word !important;
            border: 1px solid #cbd5e1 !important;
            color: black !important;
          }
          .no-print { display: none !important; }
        }
      `}</style>

      {/* --- DEEP DATA MODALS --- */}
      {activeModal.isOpen && (
        <div className="fixed inset-0 z-[60] overflow-y-auto flex items-start justify-center p-2 md:p-6">
           {/* Backdrop */}
           <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity" onClick={closeModal}></div>
           
           {/* Modal Window */}
           <div className="bg-white rounded-xl shadow-2xl w-full max-w-[calc(100vw-1.5rem)] md:max-w-6xl my-8 relative z-10 flex flex-col animate-in fade-in zoom-in-95 duration-200">
              
              {/* Modal Header */}
              <div className="p-5 border-b border-slate-200 flex justify-between items-center bg-slate-50 shrink-0">
                 <div className="flex items-center gap-3">
                   {activeModal.type === 'details' && <svg className="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                   {activeModal.type === 'boq' && <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>}
                   {activeModal.type === 'docs' && <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>}
                   {activeModal.type === 'eligibility' && <svg className="w-6 h-6 text-violet-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4M7 4h10a2 2 0 012 2v14l-7-3-7 3V6a2 2 0 012-2z" /></svg>}
                   
                   <h3 className="font-bold text-xl text-slate-800">
                     {activeModal.type === 'details' && 'Tender Details & Summary'}
                     {activeModal.type === 'boq' && 'Bill of Quantities (BOQ)'}
                     {activeModal.type === 'docs' && 'Secure Tender Documents'}
                     {activeModal.type === 'eligibility' && 'Eligibility Criteria'}
                   </h3>
                 </div>
                 <div className="flex items-center gap-2 no-print">
                   {activeModal.type === 'boq' && (
                     <>
                       <button
                         onClick={downloadBoqData}
                         className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-emerald-200 text-emerald-700 rounded-lg font-bold hover:bg-emerald-50 transition-colors shadow-sm"
                         title="Download complete BOQ data"
                       >
                         <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
                         </svg>
                         Download BOQ
                       </button>
                       <button
                         onClick={printBoqData}
                         className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg font-bold hover:bg-emerald-700 transition-colors shadow-sm"
                         title="Print BOQ Data"
                       >
                         <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 9V4h12v5M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v6H6v-6z" />
                         </svg>
                         Print
                       </button>
                     </>
                   )}
                   <button onClick={closeModal} className="text-slate-400 hover:bg-slate-200 hover:text-slate-700 p-2 rounded-full transition-colors" aria-label="Close modal">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                   </button>
                 </div>
              </div>

              {/* Modal Body */}
              <div className="p-5 bg-slate-50 flex-1">
                 <div className="mb-4">
                    <span className="text-xs font-bold text-blue-600 bg-blue-50 px-3 py-1.5 rounded-md border border-blue-100">
                      Tender ID: #{activeModal.tender.tender_id}
                    </span>
                 </div>
                 <p className="font-bold text-lg text-slate-800 mb-6 leading-relaxed">{activeModal.tender.title}</p>

                 {activeModal.type === 'details' && (
                   <div className="space-y-6">
                      {/* General Information Section */}
                      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                         <h4 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-4 border-b border-slate-100 pb-2">General Information</h4>
                         <div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-6">
                            <div><p className="text-xs text-slate-500 mb-1">Department Name</p><p className="text-sm font-medium text-slate-800">{activeModal.tender.department}</p></div>
                            <div><p className="text-xs text-slate-500 mb-1">Tender Category</p><p className="text-sm font-medium text-slate-800">{activeModal.tender.tender_category}</p></div>
                            <div><p className="text-xs text-slate-500 mb-1">Notice / IFB Number</p><p className="text-sm font-medium text-slate-800">{activeModal.tender.tender_notice_number}</p></div>
                            <div><p className="text-xs text-slate-500 mb-1">Estimated Contract Value</p><p className="text-sm font-bold text-emerald-600">{activeModal.tender.est_value}</p></div>
                         </div>
                      </div>

                      {/* Critical Dates Section */}
                      <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                         <h4 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-4 border-b border-slate-100 pb-2">Critical Dates</h4>
                         <div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-6">
                            <div><p className="text-xs text-slate-500 mb-1">Bid Document Download Start Date</p><p className="text-sm font-medium text-slate-800">{activeModal.tender.start_date}</p></div>
                            <div><p className="text-xs text-slate-500 mb-1">Bid Submission Closing Date</p><p className="text-sm font-bold text-red-600 bg-red-50 inline-block px-2 py-0.5 rounded">{activeModal.tender.closing_date}</p></div>
                         </div>
                      </div>

                      {/* Enquiry Forms Section */}
                      {activeModal.tender.enquiry_form_details && activeModal.tender.enquiry_form_details !== 'Pending Deep Extraction' && (
                         <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                            <h4 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-4 border-b border-slate-100 pb-2">Enquiry Forms</h4>
                            {(() => {
                              try {
                                const parsed = JSON.parse(activeModal.tender.enquiry_form_details || '{}');
                                const formNames = Object.keys(parsed);
                                if (formNames.length === 0) {
                                  return <p className="text-sm text-slate-500 italic">No enquiry forms available.</p>;
                                }
                                return (
                                  <div className="border border-slate-200 rounded-lg bg-white shadow-sm">
                                    <table className="w-full text-left border-collapse table-fixed">
                                      <thead>
                                        <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase font-bold">
                                          <th className="px-4 py-2.5">Stage</th>
                                          <th className="px-4 py-2.5">Form Name</th>
                                          <th className="px-4 py-2.5">Form Type</th>
                                          <th className="px-4 py-2.5 text-center">View Details</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
                                        {formNames.map((formName, idx) => {
                                          const item = parsed[formName];
                                          return (
                                            <tr key={idx} className="hover:bg-slate-50/55 transition-colors">
                                              <td className="px-4 py-3 font-medium text-slate-600">{item.stage || 'N/A'}</td>
                                              <td className="px-4 py-3 font-bold text-slate-800">{formName}</td>
                                              <td className="px-4 py-3 text-slate-600">{item.form_type || 'N/A'}</td>
                                              <td className="px-4 py-3 text-center">
                                                <button
                                                  type="button"
                                                  onClick={() => setSelectedFormDetail(formName)}
                                                  className="p-1 rounded-lg hover:bg-violet-50 text-violet-600 transition-colors inline-flex items-center justify-center"
                                                  title={`View details of ${formName}`}
                                                  aria-label={`View details of ${formName}`}
                                                >
                                                  <svg className="w-5 h-5 text-blue-600 hover:text-blue-800 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 2v6h6" />
                                                    <circle cx="10" cy="14" r="3" strokeWidth="2" />
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12.5 16.5L16 20" />
                                                  </svg>
                                                </button>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                );
                              } catch (e) {
                                return <p className="text-sm text-red-500">Failed to parse enquiry forms.</p>;
                              }
                            })()}
                         </div>
                       )}

                      {selectedFormDetail && (
                        <div className="fixed inset-0 z-[80] overflow-y-auto flex items-start justify-center p-4 md:p-6">
                          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setSelectedFormDetail(null)}></div>
                          <div className="relative z-10 bg-white rounded-2xl border border-violet-200 shadow-2xl w-full max-w-6xl my-8 flex flex-col">
                          {(() => {
                            const record = getEnquiryFormRecord(activeModal.tender.enquiry_form_details, selectedFormDetail);
                            const tables = getEnquiryFormTables(record);

                            return (
                              <>
                                <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-100 bg-violet-50">
                                  <div>
                                    <h4 className="text-sm font-bold text-violet-800 uppercase tracking-wider">Enquiry Form Details</h4>
                                    <p className="text-sm font-semibold text-slate-800 mt-1">{selectedFormDetail}</p>
                                    {record?.stage && <p className="text-xs text-slate-500 mt-1">{record.stage} {record.form_type ? `- ${record.form_type}` : ''}</p>}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setSelectedFormDetail(null)}
                                    className="px-3 py-1.5 rounded-md bg-slate-100 text-slate-600 text-xs font-bold hover:bg-slate-200 transition-colors"
                                  >
                                    Close
                                  </button>
                                </div>

                                <div className="p-6 bg-slate-50 flex-1">
                                {tables.length === 0 ? (
                                  <div className="p-5 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                                    Details for this row are not scraped yet. Run the 10-tender test or the hourly scraper to fill this data.
                                  </div>
                                ) : (
                                  <div className="space-y-5">
                                    {tables.map((table, tIdx) => {
                                      const maxCols = Math.max(...table.map(r => r.length));

                                      return (
                                        <div key={tIdx} className="border border-slate-200 rounded-lg bg-white mb-4 shadow-sm">
                                          <table className="w-full text-left border-collapse table-fixed">
                                            <tbody className="divide-y divide-slate-200">
                                              {table.map((row, rIdx) => {
                                                const isHeader = rIdx === 0;
                                                return (
                                                  <tr key={rIdx} className={isHeader ? "bg-violet-50" : "hover:bg-slate-50 transition-colors"}>
                                                    {row.map((col, cIdx) => {
                                                      const shouldSpan = row.length === 1 && maxCols > 1;
                                                      return (
                                                        <td
                                                          key={cIdx}
                                                          colSpan={shouldSpan ? maxCols : 1}
                                                          className={`px-4 py-3 text-sm align-top whitespace-normal break-words leading-relaxed ${isHeader ? "font-bold text-slate-700" : "text-slate-600"} ${shouldSpan ? "italic" : ""}`}
                                                        >
                                                          {renderTableCellContent(col, 'details')}
                                                        </td>
                                                      );
                                                    })}
                                                  </tr>
                                                );
                                              })}
                                            </tbody>
                                          </table>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                </div>
                              </>
                            );
                          })()}
                          </div>
                        </div>
                      )}

                      {/* Extended Deep Data Section (JSON parsed) */}
                      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                          {activeModal.tender.tender_details && activeModal.tender.tender_details !== 'Pending Deep Extraction' ? (
                             <div>
                                <h4 className="text-sm font-bold text-slate-800 uppercase tracking-wider mb-4 border-b border-slate-100 pb-2">Full Tender Profile</h4>
                                <div>
                                    {(() => {
                                        try {
                                            const tables = JSON.parse(activeModal.tender.tender_details);
                                            return tables.map((table, tIdx) => {
                                                // Find the maximum number of columns in this table to handle colSpans
                                                const maxCols = Math.max(...table.map(r => r.length));
                                                
                                                return (
                                                    <div key={tIdx} className="mb-6 last:mb-0 border border-slate-200 rounded-lg bg-white shadow-sm">
                                                        <table className="w-full text-left border-collapse table-fixed">
                                                            <tbody className="divide-y divide-slate-200">
                                                                {table.map((row, rIdx) => {
                                                                    const isHeader = rIdx === 0;
                                                                    return (
                                                                        <tr key={rIdx} className={isHeader ? "bg-slate-100" : "hover:bg-slate-50 transition-colors"}>
                                                                            {row.map((col, cIdx) => {
                                                                                // CRITICAL FIX: If a row has only 1 column, it's a description row. Expand it across the table!
                                                                                const shouldSpan = row.length === 1 && maxCols > 1;
                                                                                return (
                                                                                    <td 
                                                                                        key={cIdx} 
                                                                                        colSpan={shouldSpan ? maxCols : 1}
                                                                                        className={`px-4 py-3 text-sm ${isHeader ? "font-bold text-slate-700" : "text-slate-600"} ${shouldSpan ? "italic bg-slate-50/50" : ""}`}
                                                                                    >
                                                                                        {renderTableCellContent(col, 'details', {
                                                                                          onViewDetails: extractViewDetailsFromText(col).length > 0
                                                                                            ? () => setSelectedFormDetail(row[1] || cleanLinkText(col) || 'View Details')
                                                                                            : undefined
                                                                                        })}
                                                                                    </td>
                                                                                );
                                                                            })}
                                                                        </tr>
                                                                    );
                                                                })}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                );
                                            });
                                        } catch (e) {
                                            // Trigger our formatting helper if the data is a raw text blob instead of JSON
                                            return formatRawTenderDetails(activeModal.tender.tender_details);
                                        }
                                   })()}
                               </div>
                             </div>
                          ) : (
                             <div className="flex flex-col items-center justify-center py-6">
                               <div className="relative mb-4">
                                  <svg className="w-8 h-8 text-blue-500 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                  </svg>
                               </div>
                               <p className="text-sm font-bold text-slate-700">Fetching Extended Tender Profile...</p>
                               <p className="text-xs text-slate-500 text-center mt-2 max-w-md">Waiting for backend API to respond...</p>
                             </div>
                          )}
                      </div>
                   </div>
                 )}

                 {/* BOQ, Eligibility and DOCS Viewer */}
                 {(activeModal.type === 'boq' || activeModal.type === 'docs' || activeModal.type === 'eligibility') && (
                   <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden min-h-[300px]">
                      {(() => {
                          const eligibilityTablesFromForms = getEnquiryFormTables(
                            getEnquiryFormRecord(activeModal.tender.enquiry_form_details, 'Eligibility Criteria')
                          );
                          const rawData = activeModal.type === 'boq'
                            ? activeModal.tender.boq_link
                            : activeModal.type === 'docs'
                              ? activeModal.tender.document_link
                              : (eligibilityTablesFromForms.length > 0
                                  ? eligibilityTablesFromForms
                                  : activeModal.tender.eligibility_criteria);
                          const statusText = typeof rawData === 'string' ? rawData : '';
                          
                          if (!rawData || statusText === 'Pending Deep Extraction' || statusText === 'Pending Eligibility Extraction') {
                              return (
                                 <div className="flex flex-col items-center justify-center h-full min-h-[300px] px-6">
                                    <div className="relative mb-6">
                                      <svg className="w-16 h-16 text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
                                      <svg className="w-6 h-6 text-blue-500 animate-spin absolute bottom-0 right-0 bg-white rounded-full" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                      </svg>
                                    </div>
                                    <p className="text-xl font-bold text-slate-800 mb-2">Connecting to Database...</p>
                                    <p className="text-sm text-slate-500 text-center max-w-sm">
                                      Waiting for deep tender data to be returned from the API.
                                    </p>
                                 </div>
                              );
                          }

                          if (statusText === 'Not Applicable') {
                              return (
                                 <div className="flex flex-col items-center justify-center h-full min-h-[300px] px-6">
                                    <svg className="w-16 h-16 text-slate-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4M7 4h10a2 2 0 012 2v14l-7-3-7 3V6a2 2 0 012-2z"></path></svg>
                                    <p className="text-lg font-bold text-slate-700">Eligibility criteria not required</p>
                                    <p className="text-sm text-slate-500 mt-2 text-center">This tender is below the configured eligibility threshold.</p>
                                 </div>
                              );
                          }

                          if (statusText === 'No Eligibility Criteria') {
                              return (
                                 <div className="flex flex-col items-center justify-center h-full min-h-[300px] px-6">
                                    <svg className="w-16 h-16 text-slate-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6M7 4h10a2 2 0 012 2v14l-7-3-7 3V6a2 2 0 012-2z"></path></svg>
                                    <p className="text-lg font-bold text-slate-700">No eligibility criteria</p>
                                    <p className="text-sm text-slate-500 mt-2 text-center">This tender does not include an Eligibility Criteria row in Enquiry Forms.</p>
                                 </div>
                              );
                          }

                          if (statusText.includes('Data Not Found') || statusText.includes('Not Available')) {
                              return (
                                 <div className="flex flex-col items-center justify-center h-full min-h-[300px] px-6">
                                    <svg className="w-16 h-16 text-slate-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                                    <p className="text-lg font-bold text-slate-700">{statusText}</p>
                                    <p className="text-sm text-slate-500 mt-2 text-center">The portal did not provide HTML table data for this section.</p>
                                 </div>
                              );
                          }

                          try {
                              const tables = normalizeTenderTables(rawData);
                              const displayTables = activeModal.type === 'boq' ? mergeBoqTables(tables) : tables;
                              const documentLinks = activeModal.type === 'docs' ? collectLinksFromTables(displayTables) : [];
                              const storedDocumentFiles = activeModal.type === 'docs' && Array.isArray(activeModal.tender.document_files)
                                ? activeModal.tender.document_files
                                : [];

                              return (
                                  <div id={activeModal.type === 'boq' ? 'boq-print-area' : undefined} className="p-6 space-y-8">
                                       {activeModal.type === 'eligibility' && (() => {
                                         const parsed = parseEligibilityCriteria(tables);
                                         const hasAnyQuantities = 
                                            parsed.quantities.steel.length > 0 ||
                                            parsed.quantities.cc_rcc_vrcc.length > 0 ||
                                            parsed.quantities.earthwork.length > 0 ||
                                            parsed.quantities.gravel.length > 0 ||
                                            parsed.quantities.flooring.length > 0 ||
                                            parsed.quantities.plastering.length > 0 ||
                                            parsed.quantities.wbm_wmm.length > 0 ||
                                            parsed.quantities.bt_ogpc_bm.length > 0 ||
                                            parsed.quantities.etc.length > 0;
                                         return (
                                           <div className="mb-8 p-6 bg-slate-50 border border-slate-200 rounded-xl space-y-6 shadow-sm">
                                             <h4 className="text-base font-bold text-slate-800 border-b border-slate-200 pb-2 uppercase tracking-wide">
                                               Eligibility Criteria Checklist
                                             </h4>
                                             
                                             {/* 1) Similar nature of work */}
                                             <div className="space-y-1">
                                               <p className="text-sm font-bold text-slate-700 flex items-baseline flex-wrap gap-1">
                                                 <span className="text-indigo-600 font-extrabold mr-1">1)</span>
                                                 Similar nature of work: 
                                                 <span className="text-xs font-medium text-slate-500 ml-1">Last 10 year experience</span>
                                                 {parsed.similarWork && convertIndianWordsToNumber(parsed.similarWork) && (
                                                   <span className="ml-3 px-2 py-0.5 bg-emerald-100 border border-emerald-200 text-emerald-800 rounded font-mono font-bold text-xs shadow-sm">
                                                     {convertIndianWordsToNumber(parsed.similarWork)}
                                                   </span>
                                                 )}
                                               </p>
                                               <div className="pl-6 py-1 text-sm font-semibold text-slate-800">
                                                 Rupees {parsed.similarWork ? (
                                                   <span className="bg-indigo-50 border-b border-indigo-300 text-indigo-800 px-2 py-0.5 rounded font-mono break-all">{parsed.similarWork}</span>
                                                 ) : (
                                                   <span className="text-slate-400 font-mono tracking-widest">_____________________________________________</span>
                                                 )} only
                                               </div>
                                             </div>

                                             {/* 2) Liquid Asset / Bank Solvency */}
                                             <div className="space-y-1">
                                               <p className="text-sm font-bold text-slate-700 flex items-baseline flex-wrap gap-1">
                                                 <span className="text-indigo-600 font-extrabold mr-1">2)</span>
                                                 Liquid Asset/Bank Solvency:
                                                 {parsed.solvency && convertIndianWordsToNumber(parsed.solvency) && (
                                                   <span className="ml-3 px-2 py-0.5 bg-emerald-100 border border-emerald-200 text-emerald-800 rounded font-mono font-bold text-xs shadow-sm">
                                                     {convertIndianWordsToNumber(parsed.solvency)}
                                                   </span>
                                                 )}
                                               </p>
                                               <div className="pl-6 py-1 text-sm font-semibold text-slate-800">
                                                 Rupees {parsed.solvency ? (
                                                   <span className="bg-indigo-50 border-b border-indigo-300 text-indigo-800 px-2 py-0.5 rounded font-mono break-all">{parsed.solvency}</span>
                                                 ) : (
                                                   <span className="text-slate-400 font-mono tracking-widest">_____________________________________________</span>
                                                 )} only
                                               </div>
                                             </div>

                                             {/* 3) Bid capacity */}
                                             <div className="space-y-1">
                                               <p className="text-sm font-bold text-slate-700 flex items-baseline flex-wrap gap-1">
                                                 <span className="text-indigo-600 font-extrabold mr-1">3)</span>
                                                 Bid capacity:
                                                 {parsed.bidCapacity && convertIndianWordsToNumber(parsed.bidCapacity) && (
                                                   <span className="ml-3 px-2 py-0.5 bg-emerald-100 border border-emerald-200 text-emerald-800 rounded font-mono font-bold text-xs shadow-sm">
                                                     {convertIndianWordsToNumber(parsed.bidCapacity)}
                                                   </span>
                                                 )}
                                               </p>
                                               <div className="pl-6 py-1 text-sm font-semibold text-slate-800">
                                                 {parsed.bidCapacity ? (
                                                   <span className="bg-indigo-50 border-b border-indigo-300 text-indigo-800 px-2 py-0.5 rounded font-mono break-all">{parsed.bidCapacity}</span>
                                                 ) : (
                                                   <span className="text-slate-400 font-mono tracking-widest">_____________________________________________</span>
                                                 )}
                                               </div>
                                             </div>

                                             {/* 4) Quantities Required */}
                                             <div className="space-y-3">
                                               <p className="text-sm font-bold text-slate-700 flex items-baseline flex-wrap gap-1">
                                                 <span className="text-indigo-600 font-extrabold mr-1">4)</span>
                                                 Quantities Required:
                                               </p>
                                               <div className="pl-6">
                                                 <div className="border border-slate-200 rounded-lg overflow-hidden bg-white shadow-sm">
                                                   <table className="w-full text-left border-collapse table-fixed">
                                                     <thead>
                                                       <tr className="bg-slate-100 border-b border-slate-200 text-xs font-bold text-slate-600">
                                                         <th className="px-4 py-2 w-2/3">Description / Scraped Item Name</th>
                                                         <th className="px-4 py-2 w-1/6 text-right">WORK Req. QTY</th>
                                                         <th className="px-4 py-2 w-1/6 text-center">UOM</th>
                                                       </tr>
                                                     </thead>
                                                     <tbody className="divide-y divide-slate-100 text-xs text-slate-700 font-medium">
                                                       {!hasAnyQuantities ? (
                                                         <tr>
                                                           <td colSpan="3" className="px-4 py-4 text-center text-slate-400 italic">
                                                             No quantities required or extracted.
                                                           </td>
                                                         </tr>
                                                       ) : (
                                                         <>
                                                           {parsed.quantities.steel.map((item, idx) => (
                                                             <tr key={`steel-${idx}`} className="hover:bg-slate-50/50">
                                                               <td className="px-4 py-2.5 text-slate-800 font-semibold whitespace-normal break-words">{item.name}</td>
                                                               <td className="px-4 py-2.5 text-right font-bold text-indigo-700">{item.qty || "-"}</td>
                                                               <td className="px-4 py-2.5 text-center font-bold text-slate-600">{item.uom || "-"}</td>
                                                             </tr>
                                                           ))}
                                                           {parsed.quantities.cc_rcc_vrcc.map((item, idx) => (
                                                             <tr key={`cc-${idx}`} className="hover:bg-slate-50/50">
                                                               <td className="px-4 py-2.5 text-slate-800 font-semibold whitespace-normal break-words">{item.name}</td>
                                                               <td className="px-4 py-2.5 text-right font-bold text-indigo-700">{item.qty || "-"}</td>
                                                               <td className="px-4 py-2.5 text-center font-bold text-slate-600">{item.uom || "-"}</td>
                                                             </tr>
                                                           ))}
                                                           {parsed.quantities.earthwork.map((item, idx) => (
                                                             <tr key={`earth-${idx}`} className="hover:bg-slate-50/50">
                                                               <td className="px-4 py-2.5 text-slate-800 font-semibold whitespace-normal break-words">{item.name}</td>
                                                               <td className="px-4 py-2.5 text-right font-bold text-indigo-700">{item.qty || "-"}</td>
                                                               <td className="px-4 py-2.5 text-center font-bold text-slate-600">{item.uom || "-"}</td>
                                                             </tr>
                                                           ))}
                                                           {parsed.quantities.gravel.map((item, idx) => (
                                                             <tr key={`gravel-${idx}`} className="hover:bg-slate-50/50">
                                                               <td className="px-4 py-2.5 text-slate-800 font-semibold whitespace-normal break-words">{item.name}</td>
                                                               <td className="px-4 py-2.5 text-right font-bold text-indigo-700">{item.qty || "-"}</td>
                                                               <td className="px-4 py-2.5 text-center font-bold text-slate-600">{item.uom || "-"}</td>
                                                             </tr>
                                                           ))}
                                                           {parsed.quantities.flooring.map((item, idx) => (
                                                             <tr key={`flooring-${idx}`} className="hover:bg-slate-50/50">
                                                               <td className="px-4 py-2.5 text-slate-800 font-semibold whitespace-normal break-words">{item.name}</td>
                                                               <td className="px-4 py-2.5 text-right font-bold text-indigo-700">{item.qty || "-"}</td>
                                                               <td className="px-4 py-2.5 text-center font-bold text-slate-600">{item.uom || "-"}</td>
                                                             </tr>
                                                           ))}
                                                           {parsed.quantities.plastering.map((item, idx) => (
                                                             <tr key={`plastering-${idx}`} className="hover:bg-slate-50/50">
                                                               <td className="px-4 py-2.5 text-slate-800 font-semibold whitespace-normal break-words">{item.name}</td>
                                                               <td className="px-4 py-2.5 text-right font-bold text-indigo-700">{item.qty || "-"}</td>
                                                               <td className="px-4 py-2.5 text-center font-bold text-slate-600">{item.uom || "-"}</td>
                                                             </tr>
                                                           ))}
                                                           {parsed.quantities.wbm_wmm.map((item, idx) => (
                                                             <tr key={`wbm-${idx}`} className="hover:bg-slate-50/50">
                                                               <td className="px-4 py-2.5 text-slate-800 font-semibold whitespace-normal break-words">{item.name}</td>
                                                               <td className="px-4 py-2.5 text-right font-bold text-indigo-700">{item.qty || "-"}</td>
                                                               <td className="px-4 py-2.5 text-center font-bold text-slate-600">{item.uom || "-"}</td>
                                                             </tr>
                                                           ))}
                                                           {parsed.quantities.bt_ogpc_bm.map((item, idx) => (
                                                             <tr key={`bt-${idx}`} className="hover:bg-slate-50/50">
                                                               <td className="px-4 py-2.5 text-slate-800 font-semibold whitespace-normal break-words">{item.name}</td>
                                                               <td className="px-4 py-2.5 text-right font-bold text-indigo-700">{item.qty || "-"}</td>
                                                               <td className="px-4 py-2.5 text-center font-bold text-slate-600">{item.uom || "-"}</td>
                                                             </tr>
                                                           ))}
                                                           {parsed.quantities.etc.map((item, idx) => (
                                                             <tr key={`etc-${idx}`} className="hover:bg-slate-50/50">
                                                               <td className="px-4 py-2.5 text-slate-800 font-semibold whitespace-normal break-words">{item.name}</td>
                                                               <td className="px-4 py-2.5 text-right font-bold text-indigo-700">{item.qty || "-"}</td>
                                                               <td className="px-4 py-2.5 text-center font-bold text-slate-600">{item.uom || "-"}</td>
                                                             </tr>
                                                           ))}
                                                         </>
                                                       )}
                                                      </tbody>
                                                   </table>
                                                 </div>
                                               </div>
                                             </div>
                                           </div>
                                         );
                                       })()}
                                      {activeModal.type === 'boq' && displayTables.length > 0 && (
                                          <div className="flex items-center justify-between gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
                                              <div>
                                                  <p className="text-sm font-bold text-emerald-900">Merged BOQ item details</p>
                                                  <p className="text-xs text-emerald-700 mt-1">Repeated tender summary sections are hidden and item rows from all BOQ pages are combined.</p>
                                              </div>
                                              <span className="text-xs font-bold text-emerald-700 bg-white border border-emerald-200 px-3 py-1.5 rounded-md">
                                                {displayTables.reduce((total, table) => total + Math.max(table.length - 1, 0), 0)} rows
                                              </span>
                                          </div>
                                      )}
                                      {storedDocumentFiles.length > 0 && (
                                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
                                              <div>
                                                  <p className="text-sm font-bold text-emerald-900">Saved tender documents</p>
                                                  <p className="text-xs text-emerald-700 mt-1">{storedDocumentFiles.length} file{storedDocumentFiles.length > 1 ? 's' : ''} saved in the database.</p>
                                              </div>
                                              <div className="flex flex-wrap gap-2">
                                                  {storedDocumentFiles.map((file, idx) => (
                                                      file.error ? (
                                                        <span
                                                          key={`${file.filename}-${idx}`}
                                                          className="inline-flex items-center px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-bold"
                                                          title={file.error}
                                                        >
                                                          {file.filename || `File ${idx + 1}`} unavailable
                                                        </span>
                                                      ) : (
                                                        <a
                                                          key={`${file.filename}-${idx}`}
                                                          href={getStoredDocumentUrl(activeModal.tender.tender_id, file.index ?? idx)}
                                                          download
                                                          target="_blank"
                                                          rel="noreferrer"
                                                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors shadow-sm"
                                                        >
                                                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
                                                          </svg>
                                                          {file.filename || `Download ${idx + 1}`}
                                                        </a>
                                                      )
                                                  ))}
                                              </div>
                                          </div>
                                      )}
                                      {storedDocumentFiles.length === 0 && documentLinks.length > 0 && (
                                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 bg-amber-50 border border-amber-200 rounded-lg">
                                              <div>
                                                  <p className="text-sm font-bold text-amber-900">Tender document downloads available</p>
                                                  <p className="text-xs text-amber-700 mt-1">{documentLinks.length} file link{documentLinks.length > 1 ? 's' : ''} found from the portal data.</p>
                                              </div>
                                              <div className="flex flex-wrap gap-2">
                                                  {documentLinks.map((url, idx) => (
                                                      <a
                                                        key={`${url}-${idx}`}
                                                        href={getDownloadUrl(url)}
                                                        download
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-bold hover:bg-amber-700 transition-colors shadow-sm"
                                                      >
                                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" />
                                                        </svg>
                                                        Download{documentLinks.length > 1 ? ` ${idx + 1}` : ''}
                                                      </a>
                                                  ))}
                                              </div>
                                          </div>
                                      )}
                                      {activeModal.type !== 'eligibility' && displayTables.map((table, tIdx) => {
                                          // Find the maximum number of columns in this table to handle colSpans
                                          const maxCols = Math.max(...table.map(r => r.length));

                                          return (
                                              <div key={tIdx} className="border border-slate-200 rounded-lg shadow-sm bg-white mb-6">
                                                  <table className="w-full text-left border-collapse table-fixed">
                                                      <tbody className="divide-y divide-slate-200">
                                                          {table.map((row, rIdx) => {
                                                              const isHeader = rIdx === 0;
                                                              return (
                                                                  <tr key={rIdx} className={isHeader ? "bg-slate-100" : "hover:bg-slate-50 transition-colors"}>
                                                                      {row.map((col, cIdx) => {
                                                                          // CRITICAL FIX: If a row has only 1 column, it's a description row. Expand it across the table!
                                                                          const shouldSpan = row.length === 1 && maxCols > 1;
                                                                          return (
                                                                              <td 
                                                                                key={cIdx} 
                                                                                colSpan={shouldSpan ? maxCols : 1}
                                                                                className={`px-4 py-3 text-sm align-top whitespace-normal break-words leading-relaxed ${isHeader ? "font-bold text-slate-700" : "text-slate-600"} ${shouldSpan ? "italic bg-yellow-50/30 text-slate-700" : ""}`}
                                                                              >
                                                                                  {renderTableCellContent(col, activeModal.type)}
                                                                              </td>
                                                                          );
                                                                      })}
                                                                  </tr>
                                                              );
                                                          })}
                                                      </tbody>
                                                  </table>
                                              </div>
                                          );
                                      })}
                                  </div>
                              );
                          } catch (e) {
                              return (
                                  <div className="p-6">
                                      <div className="text-sm text-slate-700 whitespace-pre-wrap bg-slate-50 p-4 rounded-lg border border-slate-200 overflow-x-auto">
                                          {statusText || JSON.stringify(rawData, null, 2)}
                                      </div>
                                  </div>
                              );
                          }
                      })()}
                   </div>
                 )}
              </div>
              
              {/* Modal Footer */}
              <div className="p-5 border-t border-slate-200 bg-white flex justify-end shrink-0">
                 <button onClick={closeModal} className="px-6 py-2.5 bg-slate-900 text-white rounded-lg font-bold hover:bg-slate-800 transition-colors shadow-sm">
                    Close Window
                 </button>
              </div>
           </div>
        </div>
      )}

      {/* --- NOTIFICATION SLIDE-OUT DRAWER --- */}
      {isNotificationOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/20 z-40 transition-opacity"
          onClick={() => setIsNotificationOpen(false)}
        ></div>
      )}
      <div className={`fixed inset-y-0 right-0 w-80 md:w-96 bg-white shadow-2xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${isNotificationOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="p-5 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20"><path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z"></path></svg>
            <h3 className="font-bold text-slate-800 text-lg"><span>Marked Tenders</span></h3>
          </div>
          <button onClick={() => setIsNotificationOpen(false)} className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-full transition-colors" aria-label="Close notifications">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-slate-50">
          {markedTendersList.length === 0 ? (
            <div className="text-center mt-10">
              <svg className="w-16 h-16 text-slate-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>
              <p className="text-sm text-slate-500 font-medium"><span>No tenders marked yet.</span></p>
              <p className="text-xs text-slate-400 mt-1"><span>Click the bell icon on a tender to mark it.</span></p>
            </div>
          ) : (
            markedTendersList.map(t => (
              <div key={t.tender_id} className="p-4 border border-slate-200 rounded-xl shadow-sm hover:shadow-md transition-shadow bg-white relative group">
                <div className="flex justify-between items-start mb-2 pr-6">
                  <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-md">#{t.tender_id}</span>
                </div>
                <button 
                  onClick={() => toggleNotification(t.tender_id)} 
                  className="absolute top-4 right-4 text-slate-300 hover:text-red-500 transition-colors"
                  title="Remove Notification"
                  aria-label="Remove Notification"
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd"></path></svg>
                </button>
                <p className="text-sm text-slate-800 line-clamp-2 mb-3 mt-1 font-medium"><span>{t.title}</span></p>
                <div className="flex justify-between items-end">
                  <span className="text-xs text-slate-500"><span>{t.department}</span></span>
                  <div className="text-right">
                    <p className="text-[10px] text-slate-400 uppercase font-bold tracking-wider mb-0.5"><span>Closes</span></p>
                    <p className="text-xs text-red-600 font-bold bg-red-50 px-2 py-1 rounded-md inline-block"><span>{t.closing_date}</span></p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      {/* --------------------------------------- */}

      {/* Mobile Sidebar */}
      {isMobileSidebarOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/50 z-40 lg:hidden backdrop-blur-sm transition-opacity"
          onClick={() => setIsMobileSidebarOpen(false)}
        ></div>
      )}
      <div className={`fixed inset-y-0 left-0 w-64 bg-slate-900 text-white z-50 transform transition-transform duration-300 ease-in-out flex flex-col lg:hidden ${isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        {renderSidebarContents()}
      </div>

      {/* Desktop Sidebar (hidden on mobile, visible on lg screens) */}
      <div className="hidden lg:flex w-64 bg-slate-900 text-white flex-col shrink-0">
        {renderSidebarContents()}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="bg-white border-b border-slate-200 px-4 md:px-8 py-4 flex flex-col gap-4 lg:flex-row lg:justify-between lg:items-center shrink-0">
          <div className="flex items-center justify-between w-full lg:w-auto">
            <div className="flex items-center gap-3">
              {/* Hamburger menu button visible only on lg:hidden */}
              <button
                onClick={() => setIsMobileSidebarOpen(true)}
                className="lg:hidden p-2 hover:bg-slate-100 rounded-lg text-slate-600 transition-colors"
                aria-label="Open menu"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <div>
                <h2 className="text-xl md:text-2xl font-bold text-slate-800">Tender Overview</h2>
                <p className="text-xs md:text-sm text-slate-500 mt-0.5 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                  Live AP eProcurement Data
                </p>
              </div>
            </div>
            {/* Small Screen Action Shortcut */}
            <div className="flex items-center gap-2 lg:hidden">
              {/* Notification Bell */}
              <button 
                onClick={() => setIsNotificationOpen(true)}
                className="relative p-2 bg-white border border-slate-200 rounded-full text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition-colors shadow-sm"
                aria-label="View Marked Tenders"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>
                {notifiedTenders.length > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full border border-white shadow-sm">
                    {notifiedTenders.length}
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Search & Actions Bar */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full lg:w-auto">
            <div id="google_translate_element" className="hidden lg:block"></div>
            
            <div className="flex items-center gap-2 w-full sm:w-auto">
              {/* Search Type selector */}
              <select
                value={searchField}
                onChange={(e) => setSearchField(e.target.value)}
                className="flex-1 sm:flex-none px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white text-slate-700 outline-none"
                title="Choose search field"
              >
                <option value="all">All Fields</option>
                <option value="title">Name of Work</option>
                <option value="tender_id">Tender ID</option>
                <option value="tender_notice_number">Notice Number</option>
                <option value="department">Department</option>
              </select>

              {/* Theme Toggle */}
              <button
                type="button"
                onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
                className="px-3 py-2 border border-slate-300 rounded-lg text-sm font-bold text-slate-700 bg-white hover:bg-slate-50 transition-colors shadow-sm"
                title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme'}
              >
                {theme === 'dark' ? 'Light' : 'Dark'}
              </button>
            </div>

            {/* Search Input */}
            <div className="relative w-full sm:w-64 md:w-80">
              <svg className="w-5 h-5 absolute left-3 top-2.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
              <input 
                type="text" 
                placeholder={searchField === 'title' ? 'Search by Name of Work...' : 'Search by ID, Name of Work, Notice No...'}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {/* Desktop Notification Bell */}
            <button 
              onClick={() => setIsNotificationOpen(true)}
              className="hidden lg:relative lg:block p-2.5 bg-white border border-slate-200 rounded-full text-slate-500 hover:text-blue-600 hover:bg-blue-50 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
              title="View Marked Tenders"
              aria-label="View Marked Tenders"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>
              {notifiedTenders.length > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs font-bold flex items-center justify-center rounded-full border-2 border-white shadow-sm animate-pulse">
                  {notifiedTenders.length}
                </span>
              )}
            </button>
          </div>
        </header>

        {/* Dashboard Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-8">
          
          {/* Priority District Tabs */}
          {currentUser.districts && (
            <div className="flex space-x-2 bg-slate-200/50 p-1.5 rounded-xl mb-6 overflow-x-auto shadow-inner">
              {currentUser.districts.map((district, idx) => (
                <button
                  key={idx}
                  onClick={() => setActiveTab(idx)}
                  className={`flex-1 whitespace-nowrap px-4 py-2.5 text-sm font-bold rounded-lg transition-all ${
                    activeTab === idx 
                      ? 'bg-white text-blue-700 shadow-sm ring-1 ring-slate-200' 
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                  }`}
                >
                  {district}
                </button>
              ))}
              <button
                onClick={() => setActiveTab('more')}
                className={`flex-1 whitespace-nowrap px-4 py-2.5 text-sm font-bold rounded-lg transition-all ${
                  activeTab === 'more' 
                    ? 'bg-white text-blue-700 shadow-sm ring-1 ring-slate-200' 
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                }`}
              >
                More (All Tenders)
              </button>
            </div>
          )}

          {/* Stats Row */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 shrink-0">
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500 mb-1">Total Found</p>
                <p className="text-3xl font-bold text-slate-800">{displayTenders.length}</p>
              </div>
              <div className="p-3 bg-blue-50 rounded-lg text-blue-600">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"></path></svg>
              </div>
            </div>
            
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500 mb-1">Marked</p>
                <p className="text-3xl font-bold text-slate-800">{notifiedTenders.length}</p>
              </div>
              <div className="p-3 bg-emerald-50 rounded-lg text-emerald-600">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-500 mb-1">Global Database Size</p>
                <p className="text-lg font-bold text-slate-800">
                  {tenders.length} Records
                </p>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg text-slate-600 border border-slate-200">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"></path></svg>
              </div>
            </div>
          </div>

          {/* Data Table */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-3">
                <h3 className="font-semibold text-slate-800">{tabTitle}</h3>
                <span className="bg-blue-100 text-blue-700 text-xs px-2 py-1 rounded-full font-medium">Auto-sync: 1hr</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => downloadTenderPdf(displayTenders, 'filtered')}
                  disabled={displayTenders.length === 0}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                  title="Download current filtered tenders as PDF"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 15h6M9 11h6" />
                  </svg>
                  Filtered PDF
                </button>
                <button
                  type="button"
                  onClick={() => downloadTenderPdf(tenders, 'all')}
                  disabled={tenders.length === 0}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                  title="Download all loaded tenders as PDF"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 15h6M9 11h6" />
                  </svg>
                  All PDF
                </button>
                <button
                  type="button"
                  onClick={() => downloadTenderCsv(displayTenders, 'filtered')}
                  disabled={displayTenders.length === 0}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title="Download current filtered tenders as CSV"
                >
                  <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Filtered CSV
                </button>
                <button
                  type="button"
                  onClick={() => downloadTenderCsv(tenders, 'all')}
                  disabled={tenders.length === 0}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title="Download all loaded tenders as CSV"
                >
                  <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  All CSV
                </button>
                {loading && <span className="text-sm text-blue-600 font-medium animate-pulse">Syncing data...</span>}
              </div>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-max">
                <thead>
                  <tr className="bg-white border-b border-slate-200 text-sm text-slate-500 whitespace-nowrap">
                    <th className="px-4 py-3 font-medium text-center min-w-[190px]"><span>Actions</span></th>
                    {SORTABLE_COLUMNS.map(column => (
                      <th key={column.key} className="px-4 py-3 font-medium">
                        <SortableHeader column={column} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {error ? (
                    <tr>
                      <td colSpan="9" className="px-4 py-12 text-center text-red-500 font-medium">
                        <span>{error}</span>
                      </td>
                    </tr>
                  ) : loading ? (
                    <tr>
                      <td colSpan="9" className="px-4 py-12 text-center text-slate-400">
                        <span>Loading tenders from database...</span>
                      </td>
                    </tr>
                  ) : displayTenders.length === 0 ? (
                    <tr>
                      <td colSpan="9" className="px-4 py-12 text-center text-slate-500">
                        <div className="flex flex-col items-center">
                          <svg className="w-12 h-12 text-slate-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                          <span className="font-medium text-lg text-slate-700">No tenders found!</span>
                          <span className="text-sm mt-1">We couldn't find any active tenders matching your criteria.</span>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    paginatedTenders.map((tender, index) => {
                      const isMarked = notifiedTenders.includes(tender.tender_id);
                      return (
                        <tr key={index} className={`transition-colors ${isMarked ? 'bg-blue-50/50 hover:bg-blue-50' : 'hover:bg-slate-50'}`}>
                          
                          {/* Expanded Multi-Action Column with Modal Triggers */}
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-center gap-2">
                              {/* 1. Mark for Notification */}
                              <button 
                                onClick={() => toggleNotification(tender.tender_id)}
                                className={`p-1.5 rounded-lg transition-all shadow-sm ${
                                  isMarked 
                                    ? 'bg-blue-600 text-white hover:bg-blue-700 hover:shadow-md' 
                                    : 'bg-white border border-slate-200 text-slate-400 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50'
                                }`}
                                title={isMarked ? "Remove from Notifications" : "Mark for Notification"}
                                aria-label={isMarked ? "Remove from Notifications" : "Mark for Notification"}
                              >
                                <svg className="w-4 h-4" fill={isMarked ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>
                              </button>

                              {/* 2. View Details (Eye Icon) */}
                              <button 
                                onClick={() => openModal('details', tender)}
                                className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-indigo-600 hover:border-indigo-300 hover:bg-indigo-50 transition-all shadow-sm"
                                title="View Details"
                                aria-label="View Details"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                              </button>

                              {/* 3. BOQ Item Details (Clipboard Check) */}
                              <button 
                                onClick={() => openModal('boq', tender)}
                                className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-emerald-600 hover:border-emerald-300 hover:bg-emerald-50 transition-all shadow-sm"
                                title="BOQ Item Details"
                                aria-label="BOQ Item Details"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                              </button>

                              {/* 4. Tender Documents (Text Document) */}
                              <button 
                                onClick={() => openModal('docs', tender)}
                                className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-amber-600 hover:border-amber-300 hover:bg-amber-50 transition-all shadow-sm"
                                title="Tender Documents"
                                aria-label="Tender Documents"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 9h1M9 13h6M9 17h6" /></svg>
                              </button>

                              {/* 5. Eligibility Criteria */}
                              <button 
                                onClick={() => openModal('eligibility', tender)}
                                className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-violet-600 hover:border-violet-300 hover:bg-violet-50 transition-all shadow-sm"
                                title="Eligibility Criteria"
                                aria-label="Eligibility Criteria"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4M7 4h10a2 2 0 012 2v14l-7-3-7 3V6a2 2 0 012-2z" /></svg>
                              </button>
                            </div>
                          </td>

                          <td className="px-4 py-3 text-sm text-slate-600 whitespace-normal min-w-[150px] max-w-[200px]">
                            <span>{tender.department || 'N/A'}</span>
                          </td>
                          <td className="px-4 py-3 text-sm font-medium text-blue-600 whitespace-nowrap">
                            <span>#{tender.tender_id}</span>
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-600 whitespace-normal min-w-[150px] max-w-[200px]">
                            <span>{tender.tender_notice_number || 'N/A'}</span>
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">
                            <span>{tender.tender_category || 'N/A'}</span>
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-800 font-medium whitespace-normal min-w-[250px] max-w-[300px]">
                            <span>{tender.title || 'N/A'}</span>
                          </td>
                          <td className="px-4 py-3 text-sm font-medium text-slate-800 whitespace-nowrap">
                            <span>{tender.est_value || 'N/A'}</span>
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-500 whitespace-nowrap">
                            <span>{tender.start_date || 'N/A'}</span>
                          </td>
                          <td className="px-4 py-3 text-sm font-medium text-red-600 whitespace-nowrap">
                            <span>{tender.closing_date || 'N/A'}</span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {displayTenders.length > 0 && (
              <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row justify-between items-center gap-4 shrink-0 no-print">
                <div className="flex items-center gap-4 text-sm text-slate-500 font-medium">
                  <span className="flex items-center gap-2">
                    <span>Show</span>
                    <select
                      value={itemsPerPage}
                      onChange={(e) => {
                        setItemsPerPage(Number(e.target.value));
                        setCurrentPage(1);
                      }}
                      className="px-2 py-1 border border-slate-300 rounded bg-white text-slate-700 outline-none focus:border-blue-500 text-xs font-bold"
                    >
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                    </select>
                    <span>entries</span>
                  </span>
                  <span>
                    Showing {Math.min(displayTenders.length, (currentPage - 1) * itemsPerPage + 1)} to{' '}
                    {Math.min(displayTenders.length, currentPage * itemsPerPage)} of {displayTenders.length} entries
                  </span>
                </div>

                <div className="flex items-center gap-1 flex-wrap justify-center">
                  <button
                    onClick={() => setCurrentPage(1)}
                    disabled={currentPage === 1}
                    className="px-2.5 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-xs font-bold"
                  >
                    First
                  </button>
                  <button
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                    className="px-2.5 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-xs font-bold"
                  >
                    Previous
                  </button>

                  {/* Render page numbers intelligently */}
                  {(() => {
                    const totalPages = Math.ceil(displayTenders.length / itemsPerPage);
                    const pages = [];
                    const maxVisiblePages = 5;
                    
                    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
                    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
                    
                    if (endPage - startPage + 1 < maxVisiblePages) {
                      startPage = Math.max(1, endPage - maxVisiblePages + 1);
                    }

                    for (let i = startPage; i <= endPage; i++) {
                      pages.push(
                        <button
                          key={i}
                          onClick={() => setCurrentPage(i)}
                          className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${
                            currentPage === i
                              ? 'bg-blue-600 text-white shadow-sm'
                              : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {i}
                        </button>
                      );
                    }
                    return pages;
                  })()}

                  <button
                    onClick={() => {
                      const totalPages = Math.ceil(displayTenders.length / itemsPerPage);
                      setCurrentPage(prev => Math.min(totalPages, prev + 1));
                    }}
                    disabled={currentPage === Math.ceil(displayTenders.length / itemsPerPage)}
                    className="px-2.5 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-xs font-bold"
                  >
                    Next
                  </button>
                  <button
                    onClick={() => {
                      const totalPages = Math.ceil(displayTenders.length / itemsPerPage);
                      setCurrentPage(totalPages);
                    }}
                    disabled={currentPage === Math.ceil(displayTenders.length / itemsPerPage)}
                    className="px-2.5 py-1.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-xs font-bold"
                  >
                    Last
                  </button>
                </div>
              </div>
            )}
          </div>
          
        </main>
      </div>
    </div>
  );
}
