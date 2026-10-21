/* Справочники материалов и доборных элементов */
window.KP = window.KP || {};

KP.TYPES = {
  tile:   { label: 'Металлочерепица', short: 'МЧ' },
  sheet:  { label: 'Профлист',        short: 'ПЛ' },
  siding: { label: 'Металлосайдинг',  short: 'СД' }
};

/* Недопустимые длины листов по справочнику производителя (диапазоны, м). */
KP.forbiddenLengthsCatalog = {
  tile: '0,75–0,751; 1,10–1,101; 1,45–1,451; 1,80–1,801; 2,15–2,151; ' +
        '2,50–2,501; 2,85–2,851; 3,20–3,201; 3,55–3,551; 3,90–3,901; ' +
        '4,90–4,96; 5,30–5,31; 5,65–5,66; 6,00–6,01',
  sheet: '0,47–0,48; 0,82–0,83; 1,17–1,18; 1,52–1,53; 1,87–1,88; ' +
         '2,22–2,23; 2,57–2,58; 2,92–2,93; 3,27–3,28; 3,62–3,63; ' +
         '3,97–3,98; 4,32–4,33; 4,67–4,68; 5,02–5,03; 5,37–5,38; ' +
         '5,72–5,73; 6,07–6,08; 6,42–6,43; 6,77–6,78; 7,12–7,13; 7,47–7,48',
  siding: ''
};

KP.defaultForbiddenLengths = function (type) {
  return KP.forbiddenLengthsCatalog[type] || '';
};

KP.parseLengthRanges = function (text) {
  const ranges = [];
  String(text || '').split(/[;\n]+/).forEach(function (chunk) {
    const numbers = (chunk.match(/\d+(?:[.,]\d+)?/g) || []).map(function (value) {
      return parseFloat(value.replace(',', '.'));
    }).filter(function (value) { return Number.isFinite(value); });
    if (numbers.length >= 2) {
      ranges.push({ from: Math.min(numbers[0], numbers[1]), to: Math.max(numbers[0], numbers[1]) });
    } else if (numbers.length === 1) {
      ranges.push({ from: numbers[0], to: numbers[0] });
    }
  });
  return ranges;
};

KP.formatLengthRanges = function (ranges) {
  const formatNumber = function (value) {
    return Number(value.toFixed(3)).toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 3
    });
  };
  return (ranges || []).map(function (range) {
    const from = Number(range.from);
    const to = Number(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return '';
    return formatNumber(from) + '–' + formatNumber(to);
  }).filter(Boolean).join('; ');
};

/* Исходные данные металлочерепицы «Классик» из справочника производителя. */
KP.classicAllowedLengths =
  '0,45–0,54; 0,56–0,72; 0,80–1,07; 1,15–1,42; 1,50–1,77; 1,85–2,12;\n' +
  '2,20–2,47; 2,55–2,82; 2,90–3,17; 3,25–3,52; 3,60–3,87; 3,95–4,22;\n' +
  '4,30–4,57; 4,65–4,92; 5,00–5,27; 5,35–5,62; 5,70–5,97; 6,05–6,32;\n' +
  '6,40–6,67; 6,75–7,02; 7,10–7,37; 7,45–7,72; 7,80–8,00';

KP.classicForbiddenLengths =
  '0,54–0,56; 0,72–0,80; 1,07–1,15; 1,42–1,50; 1,77–1,85; 2,12–2,20;\n' +
  '2,47–2,55; 2,82–2,90; 3,17–3,25; 3,52–3,60; 3,87–3,95; 4,22–4,30;\n' +
  '4,57–4,65; 4,92–5,00; 5,27–5,35; 5,62–5,70; 5,97–6,05; 6,32–6,40;\n' +
  '6,67–6,75; 7,02–7,10; 7,37–7,45; 7,72–7,80';

KP.defaultMaterialSource = function (type, name, id) {
  const isClassic = id === 'mat-tile-classic' || /классик/i.test(name || '');
  if (isClassic) {
    return {
      nomenclatureCode: '715690',
      calcType: 'Профиль волновой',
      coating: 'Drap',
      lockOverlap: 100,
      roundingMm: 10,
      eaveOverhang: 50,
      waveStep: 0.35,
      trimAllowance: 120,
      allowedLengths: KP.classicAllowedLengths
    };
  }
  return {
    nomenclatureCode: '',
    calcType: type === 'tile' || type === 'sheet' ? 'Профиль волновой' : '',
    coating: '',
    lockOverlap: type === 'tile' ? 100 : 0,
    roundingMm: type === 'tile' ? 10 : 0,
    eaveOverhang: type === 'tile' ? 50 : 0,
    waveStep: type === 'tile' ? 0.35 : (type === 'sheet' ? 0.2 : 0),
    trimAllowance: type === 'tile' ? 120 : 0,
    allowedLengths: ''
  };
};

KP.defaultMaterials = function () {
  return [
    {
      id: 'mat-tile-classic',
      type: 'tile',
      name: 'Металлочерепица «Классик»',
      fullWidth: 1.189,
      usefulWidth: 1.10,
      maxLength: 8,
      minLength: 0.45,
      forbiddenLengths: KP.classicForbiddenLengths,
      nomenclatureCode: '715690',
      calcType: 'Профиль волновой',
      coating: 'Drap',
      lockOverlap: 100,
      roundingMm: 10,
      eaveOverhang: 50,
      allowedLengths: KP.classicAllowedLengths,
      price: 690,
      color: 'RAL 8017 шоколад',
      waveStep: 0.35,
      trimAllowance: 120,
      thickness: 0.5
    },
    {
      id: 'mat-tile-monte',
      type: 'tile',
      name: 'Металлочерепица «Монтеррей»',
      fullWidth: 1.19,
      usefulWidth: 1.10,
      maxLength: 6,
      minLength: 0.5,
      forbiddenLengths: KP.defaultForbiddenLengths('tile'),
      nomenclatureCode: '',
      calcType: 'Профиль волновой',
      coating: '',
      lockOverlap: 100,
      roundingMm: 10,
      eaveOverhang: 50,
      allowedLengths: '',
      price: 720,
      color: 'RAL 3005 вишня',
      waveStep: 0.35,
      trimAllowance: 120,
      thickness: 0.5
    },
    {
      id: 'mat-sheet-mp20',
      type: 'sheet',
      name: 'Профлист МП-20',
      fullWidth: 1.15,
      usefulWidth: 1.10,
      maxLength: 12,
      minLength: 0.5,
      forbiddenLengths: KP.defaultForbiddenLengths('sheet'),
      nomenclatureCode: '',
      calcType: 'Профиль волновой',
      coating: '',
      lockOverlap: 0,
      roundingMm: 0,
      eaveOverhang: 0,
      allowedLengths: '',
      price: 540,
      color: 'RAL 6005 зелёный',
      waveStep: 0.20,
      trimAllowance: 0,
      thickness: 0.5
    },
    {
      id: 'mat-sheet-c44',
      type: 'sheet',
      name: 'Профлист С-44',
      fullWidth: 1.04,
      usefulWidth: 1.00,
      maxLength: 12,
      minLength: 0.5,
      forbiddenLengths: KP.defaultForbiddenLengths('sheet'),
      nomenclatureCode: '',
      calcType: 'Профиль волновой',
      coating: '',
      lockOverlap: 0,
      roundingMm: 0,
      eaveOverhang: 0,
      allowedLengths: '',
      price: 610,
      color: 'оцинкованный',
      waveStep: 0.25,
      trimAllowance: 0,
      thickness: 0.5
    },
    {
      id: 'mat-siding-evrobus',
      type: 'siding',
      name: 'Сайдинг «Евробрус»',
      fullWidth: 0.255,
      usefulWidth: 0.230,
      maxLength: 4,
      minLength: 0.3,
      forbiddenLengths: KP.defaultForbiddenLengths('siding'),
      nomenclatureCode: '',
      calcType: '',
      coating: '',
      lockOverlap: 0,
      roundingMm: 0,
      eaveOverhang: 0,
      allowedLengths: '',
      price: 480,
      color: 'RAL 8017 шоколад',
      waveStep: 0,
      trimAllowance: 0,
      thickness: 0.45
    }
  ];
};

KP.elementsCatalog = function () {
  return [
    { name: 'Конёк полукруглый',            unit: 'м',  price: 850 },
    { name: 'Конёк плоский',                unit: 'м',  price: 780 },
    { name: 'Ендова нижняя',                unit: 'м',  price: 950 },
    { name: 'Ендова верхняя',               unit: 'м',  price: 900 },
    { name: 'Торцевая планка',              unit: 'м',  price: 650 },
    { name: 'Карнизная планка',             unit: 'м',  price: 600 },
    { name: 'Планка примыкания',            unit: 'м',  price: 700 },
    { name: 'Планка внутренняя угловая',    unit: 'м',  price: 750 },
    { name: 'Планка наружная угловая',      unit: 'м',  price: 750 },
    { name: 'Уплотнитель универсальный',    unit: 'м',  price: 120 },
    { name: 'Саморезы кровельные',          unit: 'шт', price: 8 },
    { name: 'Гвозди 40х2',                  unit: 'шт', price: 3 }
  ];
};
