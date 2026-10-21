/* Ядро: модель проекта и расчёт раскладки */
(function () {
  const KP = window.KP;

  KP.STORAGE_KEY = 'krovlya-profi-web-v1';

  KP.edgeTypeLabels = {
    eave: 'карниз',
    ridge: 'конёк',
    rib: 'ребро',
    valley: 'ендова',
    end: 'торец'
  };

  KP.uid = function (prefix) {
    return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  };

  KP.today = function () {
    return new Date().toLocaleDateString('ru-RU');
  };

  KP.fmt = function (value, digits) {
    const d = typeof digits === 'number' ? digits : 2;
    const n = Number.isFinite(value) ? value : 0;
    return n.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
  };

  KP.num = function (value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (value === null || value === undefined) return 0;
    const n = parseFloat(String(value).replace(/\s+/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };

  KP.multiply = function (a, b) {
    return KP.num(a) * KP.num(b);
  };

  KP.roundUp = function (value, step) {
    if (!step || step <= 0) return value;
    return Math.ceil(value / step - 1e-9) * step;
  };

  KP.clone = function (obj) {
    return JSON.parse(JSON.stringify(obj));
  };

  KP.newProject = function () {
    return {
      version: 1,
      id: KP.uid('calc'),
      number: String(100000 + Math.floor(Math.random() * 900000)),
      name: 'Новый проект',
      customer: '',
      date: KP.today(),
      materials: KP.defaultMaterials(),
      slopes: [],
      objects: [],
      elements: [],
      underlay: null
    };
  };

  KP.save = function (project) {
    try {
      localStorage.setItem(KP.STORAGE_KEY, JSON.stringify(project));
    } catch (e) { /* файловый режим может запрещать localStorage */ }
  };

  KP.load = function () {
    try {
      const raw = localStorage.getItem(KP.STORAGE_KEY);
      if (!raw) return null;
      const project = JSON.parse(raw);
      return KP.normalizeProject(project);
    } catch (e) {
      return null;
    }
  };

  KP.normalizeProject = function (project) {
    const base = KP.newProject();
    if (!project || typeof project !== 'object') return base;
    const result = Object.assign(base, project);
    if (!result.number) result.number = String(100000 + Math.floor(Math.random() * 900000));
    if (!Array.isArray(result.materials) || result.materials.length === 0) {
      result.materials = KP.defaultMaterials();
    }
    result.materials = result.materials.map(function (material) {
      const item = material && typeof material === 'object' ? material : {};
      item.id = item.id || KP.uid('mat');
      item.type = KP.TYPES[item.type] ? item.type : 'tile';
      item.name = item.name || 'Материал';
      const source = KP.defaultMaterialSource(item.type, item.name, item.id);
      ['nomenclatureCode', 'calcType', 'coating', 'allowedLengths'].forEach(function (key) {
        if (typeof item[key] !== 'string') item[key] = source[key];
      });
      ['lockOverlap', 'roundingMm', 'eaveOverhang', 'waveStep', 'trimAllowance'].forEach(function (key) {
        if (!Number.isFinite(Number(item[key]))) item[key] = source[key];
      });
      if (typeof item.forbiddenLengths !== 'string') {
        item.forbiddenLengths = KP.defaultForbiddenLengths(item.type);
      }
      const isClassic = item.id === 'mat-tile-classic' || /классик/i.test(item.name);
      if (isClassic) {
        if (Math.abs(KP.num(item.minLength) - 0.5) < 1e-9) item.minLength = 0.45;
        if (Math.abs(KP.num(item.maxLength) - 6) < 1e-9) item.maxLength = 8;
        if (Math.abs(KP.num(item.fullWidth) - 1.19) < 1e-9) item.fullWidth = 1.189;
        if (item.forbiddenLengths === KP.forbiddenLengthsCatalog.tile) {
          item.forbiddenLengths = KP.classicForbiddenLengths;
        }
      }
      return item;
    });
    if (!Array.isArray(result.slopes)) result.slopes = [];
    if (!Array.isArray(result.objects)) result.objects = [];
    if (!Array.isArray(result.elements)) result.elements = [];
    result.objects = result.objects.map(function (obj) {
      const item = obj && typeof obj === 'object' ? obj : {};
      item.id = item.id || KP.uid('obj');
      item.kind = item.kind || 'polyline';
      item.layer = item.layer || '0';
      item.color = item.color || '#2f6f9f';
      item.closed = !!item.closed;
      if (Array.isArray(item.points)) {
        item.points = item.points.map(function (p) {
          return { x: Number(KP.num(p.x).toFixed(3)), y: Number(KP.num(p.y).toFixed(3)) };
        });
      } else {
        item.points = [];
      }
      if (item.kind === 'circle') {
        item.cx = Number(KP.num(item.cx).toFixed(3));
        item.cy = Number(KP.num(item.cy).toFixed(3));
        item.r = Math.max(0, Number(KP.num(item.r).toFixed(3)));
      }
      if (item.kind === 'text') {
        item.x = Number(KP.num(item.x).toFixed(3));
        item.y = Number(KP.num(item.y).toFixed(3));
        item.text = String(item.text == null ? '' : item.text);
        item.height = Math.max(0.05, Number(KP.num(item.height).toFixed(3)));
        item.rotation = Number(KP.num(item.rotation).toFixed(3));
      }
      return item;
    }).filter(function (obj) {
      if (obj.kind === 'circle') return obj.r > 0;
      if (obj.kind === 'text') return obj.text.length > 0;
      return obj.points.length >= 2;
    });
    // Автоматические названия приводим к единому виду «Скат №1», «Скат №2»…
    let autoSlopeNumber = 0;
    const autoSlopeName = /^(?:Скат(?:\s*№?\s*\d+)?|Фасад(?:\s*№?\s*\d+)?|Навес\s*\d+|Фигура\s*\d+|Полилиния\s*\d+|Раскладка\s*·|Новая фигура|Скат по координатам|Скат по отрезкам)/i;
    result.slopes.forEach(function (s) {
      s.id = s.id || KP.uid('slope');
      s.shape = s.shape || 'rect';
      s.width = KP.num(s.width) || 10;
      s.height = KP.num(s.height) || 5;
      s.topWidth = s.shape === 'trapezoid' ? (KP.num(s.topWidth) || KP.num(s.width) * 0.6) : 0;
      if (s.shape === 'polygon') {
        if (Array.isArray(s.points) && s.points.length >= 3) {
          const norm = KP.normalizePoints(s.points);
          s.points = norm.points;
          s.width = norm.width || 1;
          s.height = norm.height || 1;
        } else {
          s.shape = 'rect';
          s.points = [];
        }
        s.topWidth = 0;
      }
      s.rounding = KP.num(s.rounding);
      s.angle = KP.num(s.angle) || 30;
      s.sourceObjectId = s.sourceObjectId || null;
      s.inPlace = !!s.inPlace;
      if (s.inPlace && s.anchor && Number.isFinite(Number(s.anchor.x)) && Number.isFinite(Number(s.anchor.y))) {
        s.anchor = { x: Number(KP.num(s.anchor.x).toFixed(3)), y: Number(KP.num(s.anchor.y).toFixed(3)) };
      } else {
        s.inPlace = false;
        s.anchor = null;
      }
      s.dragOffset = (s.dragOffset &&
        Number.isFinite(Number(s.dragOffset.x)) && Number.isFinite(Number(s.dragOffset.y)))
        ? { x: Number(KP.num(s.dragOffset.x).toFixed(3)), y: Number(KP.num(s.dragOffset.y).toFixed(3)) }
        : { x: 0, y: 0 };
      s.sheetLengthDeltas = Array.isArray(s.sheetLengthDeltas)
        ? s.sheetLengthDeltas.slice(0, 50).map(function (value) {
          return Number(KP.num(value).toFixed(3));
        })
        : [];
      s.rotation = Number(KP.num(s.rotation).toFixed(4));
      if (s.renderOrigin && Number.isFinite(Number(s.renderOrigin.x)) && Number.isFinite(Number(s.renderOrigin.y))) {
        s.renderOrigin = {
          x: Number(KP.num(s.renderOrigin.x).toFixed(3)),
          y: Number(KP.num(s.renderOrigin.y).toFixed(3))
        };
      } else {
        s.renderOrigin = null;
        s.rotation = 0;
      }
      s.layoutStart = s.layoutStart === 'right' ? 'right' : 'left';
      s.layoutStartEdge = s.layoutStartEdge !== false;
      const wasAxisLayout = s.layoutMode === 'axis';
      const manualLayout = s.layoutMode === 'manual';
      s.layoutMode = manualLayout ? 'manual' : 'edge';
      s.layoutAngle = KP.num(s.layoutAngle);
      while (s.layoutAngle < 0) s.layoutAngle += 360;
      while (s.layoutAngle >= 360) s.layoutAngle -= 360;
      if (!s.layoutAngle && !manualLayout) s.layoutAngle = 90;
      const legacyAxisEdge = Number.isInteger(Number(s.axisEdge)) ? Number(s.axisEdge) : null;
      s.axisEdge = null;
      s.axisOrientation = 'vertical';
      s.layoutMirror = manualLayout ? !!s.layoutMirror : false;
      s.eaveEdge = Number.isInteger(Number(s.eaveEdge)) ? Number(s.eaveEdge) : null;
      s.ridgeEdge = Number.isInteger(Number(s.ridgeEdge)) ? Number(s.ridgeEdge) : null;
      if (s.eaveEdge != null && s.ridgeEdge != null && s.eaveEdge === s.ridgeEdge) {
        s.ridgeEdge = null;
      }
      const pointCount = Array.isArray(s.points) ? s.points.length : 0;
      const allowedTypes = Object.keys(KP.edgeTypeLabels);
      let edgeTypes = Array.isArray(s.edgeTypes) ? s.edgeTypes.slice(0, pointCount) : [];
      while (edgeTypes.length < pointCount) edgeTypes.push('rib');
      edgeTypes = edgeTypes.map(function (type) {
        return allowedTypes.indexOf(type) >= 0 ? type : 'rib';
      });
      if (pointCount) {
        if (s.eaveEdge == null || s.eaveEdge < 0 || s.eaveEdge >= pointCount) {
          const foundEave = edgeTypes.indexOf('eave');
          s.eaveEdge = foundEave >= 0 ? foundEave : null;
        }
        if (wasAxisLayout && s.eaveEdge == null &&
            legacyAxisEdge != null && legacyAxisEdge >= 0 && legacyAxisEdge < pointCount) {
          s.eaveEdge = legacyAxisEdge;
        }
        if (s.ridgeEdge == null || s.ridgeEdge < 0 || s.ridgeEdge >= pointCount) {
          const foundRidge = edgeTypes.indexOf('ridge');
          s.ridgeEdge = foundRidge >= 0 && foundRidge !== s.eaveEdge ? foundRidge : null;
        }
        edgeTypes = edgeTypes.map(function (type, index) {
          if (type === 'eave' && s.eaveEdge != null && index !== s.eaveEdge) return 'rib';
          if (type === 'ridge' && s.ridgeEdge != null && index !== s.ridgeEdge) return 'rib';
          return type;
        });
        if (s.eaveEdge != null) edgeTypes[s.eaveEdge] = 'eave';
        if (s.ridgeEdge != null && s.ridgeEdge !== s.eaveEdge) edgeTypes[s.ridgeEdge] = 'ridge';
      }
      s.edgeTypes = edgeTypes;
      // Вырезы внутри ската: участки, где материал не раскладывается.
      const rawCutouts = Array.isArray(s.cutouts) ? s.cutouts : [];
      s.cutouts = rawCutouts.map(function (cut, index) {
        const item = cut && typeof cut === 'object' ? cut : {};
        let points = Array.isArray(item.points) ? item.points : [];
        points = points.map(function (p) {
          return { x: Number(KP.num(p.x).toFixed(3)), y: Number(KP.num(p.y).toFixed(3)) };
        }).filter(function (p) { return Number.isFinite(p.x) && Number.isFinite(p.y); });
        while (points.length > 3) {
          const first = points[0];
          const last = points[points.length - 1];
          if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) points.pop();
          else break;
        }
        if (points.length < 3) return null;
        return {
          id: item.id || KP.uid('cut'),
          name: String(item.name || ('Вырез ' + (index + 1))),
          points: points
        };
      }).filter(Boolean);
      if (autoSlopeName.test(String(s.name || ''))) {
        autoSlopeNumber += 1;
        s.name = 'Скат №' + autoSlopeNumber;
      }
      if (!result.materials.some(function (m) { return m.id === s.materialId; })) {
        s.materialId = result.materials[0].id;
      }
    });
    result.elements.forEach(function (e) {
      e.id = e.id || KP.uid('el');
      e.qty = KP.num(e.qty);
      e.price = KP.num(e.price);
    });
    if (result.underlay && result.underlay.dataUrl) {
      const u = result.underlay;
      result.underlay = {
        name: u.name || 'изображение',
        dataUrl: u.dataUrl,
        x: KP.num(u.x),
        y: KP.num(u.y),
        width: KP.num(u.width) || 50,
        height: KP.num(u.height) || 30,
        opacity: u.opacity === undefined ? 0.5 : KP.num(u.opacity),
        visible: u.visible !== false,
        source: u.source || 'image',
        meta: u.meta && typeof u.meta === 'object' ? u.meta : null
      };
    } else {
      result.underlay = null;
    }
    return result;
  };

  KP.getMaterial = function (project, materialId) {
    return project.materials.find(function (m) { return m.id === materialId; }) || project.materials[0];
  };

  KP.newSlope = function (project, materialId) {
    const material = KP.getMaterial(project, materialId);
    const type = material ? material.type : 'tile';
    return {
      id: KP.uid('slope'),
      name: type === 'siding' ? 'Фасад' : 'Скат',
      shape: 'rect',
      width: type === 'siding' ? 8 : 10,
      height: type === 'siding' ? 3 : 5,
      topWidth: 0,
      materialId: material ? material.id : (project.materials[0] && project.materials[0].id),
      angle: type === 'siding' ? 90 : 30,
      rounding: 0,
      edgeTypes: [],
      cutouts: [],
      layoutMode: 'edge',
      layoutAngle: 90,
      axisEdge: null,
      axisOrientation: 'vertical',
      layoutMirror: false,
      dragOffset: { x: 0, y: 0 },
      sheetLengthDeltas: []
    };
  };

  /* ---------- геометрия ---------- */

  KP.normalizePoints = function (points) {
    const clean = (points || [])
      .map(function (p) {
        return { x: Number(KP.num(p.x).toFixed(3)), y: Number(KP.num(p.y).toFixed(3)) };
      })
      .filter(function (p) { return Number.isFinite(p.x) && Number.isFinite(p.y); });
    if (clean.length > 1) {
      const first = clean[0];
      const last = clean[clean.length - 1];
      if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
        clean.pop();
      }
    }
    const minX = Math.min.apply(null, clean.map(function (p) { return p.x; }));
    const minY = Math.min.apply(null, clean.map(function (p) { return p.y; }));
    const shifted = clean.map(function (p) {
      return { x: Number((p.x - minX).toFixed(3)), y: Number((p.y - minY).toFixed(3)) };
    });
    const maxX = Math.max.apply(null, shifted.map(function (p) { return p.x; }));
    const maxY = Math.max.apply(null, shifted.map(function (p) { return p.y; }));
    return { points: shifted, width: maxX, height: maxY };
  };

  KP.polygonArea = function (points) {
    if (!points || points.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  };

  /* Суммарная площадь вырезов внутри ската. */
  KP.cutoutArea = function (slope) {
    if (!slope || !Array.isArray(slope.cutouts)) return 0;
    return slope.cutouts.reduce(function (sum, cut) {
      return sum + KP.polygonArea(cut && cut.points ? cut.points : []);
    }, 0);
  };

  /* Локальные точки контура фигуры (x: 0..width, y: 0..height) */
  KP.slopePoints = function (slope) {
    const w = KP.num(slope.width);
    const h = KP.num(slope.height);
    if (slope.shape === 'polygon' && Array.isArray(slope.points) && slope.points.length >= 3) {
      return slope.points.map(function (p) { return [KP.num(p.x), KP.num(p.y)]; });
    }
    if (slope.shape === 'triangle') {
      return [[w / 2, 0], [w, h], [0, h]];
    }
    if (slope.shape === 'trapezoid') {
      const tw = Math.max(0, Math.min(KP.num(slope.topWidth), w));
      return [[(w - tw) / 2, 0], [(w + tw) / 2, 0], [w, h], [0, h]];
    }
    return [[0, 0], [w, 0], [w, h], [0, h]];
  };

  KP.shapeArea = function (slope) {
    const w = KP.num(slope.width);
    const h = KP.num(slope.height);
    if (slope.shape === 'polygon') {
      return KP.polygonArea(slope.points);
    }
    if (slope.shape === 'triangle') return w * h / 2;
    if (slope.shape === 'trapezoid') {
      const tw = Math.min(KP.num(slope.topWidth), w);
      return (w + tw) / 2 * h;
    }
    return w * h;
  };

  /* Базовая высота для простых фигур: от верхней кромки до нижней. */
  KP._heightAtBase = function (slope, x) {
    const w = KP.num(slope.width);
    const h = KP.num(slope.height);
    if (w <= 0) return 0;
    if (slope.shape === 'rect') return h;
    const tw = slope.shape === 'triangle' ? 0 : Math.max(0, Math.min(KP.num(slope.topWidth), w));
    const half = w / 2;
    const dx = Math.abs(x - half);
    const flat = tw / 2;
    if (dx <= flat) return h;
    const edge = half - flat;
    if (edge <= 1e-9) return h;
    return h * Math.max(0, (half - dx) / edge);
  };

  /* Вертикальный участок фигуры в точке x: { top, bottom, length } */
  KP.spanAt = function (slope, x) {
    if (slope.shape === 'polygon' && Array.isArray(slope.points) && slope.points.length >= 3) {
      const pts = slope.points;
      const ys = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if ((a.x <= x && b.x > x) || (b.x <= x && a.x > x)) {
          const t = (x - a.x) / (b.x - a.x);
          ys.push(a.y + t * (b.y - a.y));
        }
      }
      if (ys.length < 2) return { top: 0, bottom: 0, length: 0 };
      const top = Math.min.apply(null, ys);
      const bottom = Math.max.apply(null, ys);
      return { top: top, bottom: bottom, length: Math.max(0, bottom - top) };
    }
    const length = Math.max(0, KP._heightAtBase(slope, x));
    const bottom = KP.num(slope.height);
    return { top: Math.max(0, bottom - length), bottom: bottom, length: length };
  };

  KP.heightAt = function (slope, x) {
    return KP.spanAt(slope, x).length;
  };

  KP.columnCount = function (slope, usefulWidth) {
    const w = KP.num(slope.width);
    const uw = KP.num(usefulWidth) || 1;
    return Math.max(1, Math.ceil(w / uw - 1e-9));
  };

  /* ---------- расчёт ската ---------- */

  KP.layoutRows = function (height, material) {
    const maxLength = KP.num(material.maxLength) || 6;
    const overlap = Math.max(0, KP.num(material.lockOverlap) / 1000);
    const eave = Math.max(0, KP.num(material.eaveOverhang) / 1000);
    const total = Math.max(0, KP.num(height)) + eave;
    if (total <= maxLength + 1e-9) return 1;
    const step = Math.max(0.01, maxLength - overlap);
    return 1 + Math.ceil((total - maxLength) / step - 1e-9);
  };

  KP.sheetLengths = function (height, material, rounding) {
    const maxLength = KP.num(material.maxLength) || 6;
    const minLength = KP.num(material.minLength) || 0;
    const overlap = Math.max(0, KP.num(material.lockOverlap) / 1000);
    const eave = Math.max(0, KP.num(material.eaveOverhang) / 1000);
    const roundStep = KP.num(rounding);
    const total = Math.max(0, KP.num(height)) + eave;
    const step = KP.num(material.waveStep);
    const allowance = Math.max(0, KP.num(material.trimAllowance) / 1000);
    // Основное правило (как в примерах раскладки): длина листа кратна шагу
    // волны плюс припуск на подрезку, но не меньше одной волны.
    if (step > 0.001) {
      const waveLength = function (value) {
        const waves = Math.max(1, Math.round(Math.max(0, value) / step));
        return waves * step + allowance;
      };
      const single = waveLength(total);
      if (single <= maxLength + 1e-9) {
        return [Math.max(minLength, Number(single.toFixed(3)))];
      }
      const maxWaves = Math.max(1, Math.floor((maxLength - allowance) / step + 1e-9));
      const full = Math.min(maxLength, maxWaves * step + allowance);
      const lengths = [];
      let rest = total;
      let guard = 0;
      while (rest > maxLength + 1e-9 && guard++ < 20) {
        lengths.push(Number(full.toFixed(3)));
        rest -= Math.max(0.01, full - overlap);
      }
      let topLength = waveLength(rest);
      if (topLength > maxLength + 1e-9) topLength = full;
      lengths.push(Math.max(minLength, Number(topLength.toFixed(3))));
      return lengths;
    }
    const rows = KP.layoutRows(height, material);
    const coverPerFull = Math.max(0.01, maxLength - overlap);
    const lengths = [];
    for (let r = 0; r < rows - 1; r++) lengths.push(maxLength);
    let lastLength = total - (rows - 1) * coverPerFull;
    if (rows > 1 && lastLength < minLength) {
      const deficit = minLength - lastLength;
      lengths[lengths.length - 1] = Math.max(0.01, lengths[lengths.length - 1] - deficit);
      lastLength = minLength;
    }
    if (roundStep > 0) {
      lastLength = KP.roundUp(lastLength, roundStep);
    } else if (lastLength < minLength) {
      lastLength = minLength;
    }
    lengths.push(lastLength);
    return lengths;
  };

  // Ручные поправки длин по рядам (в метрах, от карниза к коньку).
  // Соседние листы компенсируют друг друга, поэтому общая высота
  // раскладки и нахлёст не меняются.
  KP.applySheetDeltas = function (lengths, deltas, material) {
    const minLength = Math.max(0.01, KP.num(material && material.minLength));
    const maxLength = KP.num(material && material.maxLength) || 6;
    return (lengths || []).map(function (length, index) {
      const delta = Number(deltas && deltas[index]);
      const value = length + (Number.isFinite(delta) ? delta : 0);
      return Math.max(minLength, Math.min(maxLength, value));
    });
  };

  KP.calcSlope = function (slope, material) {
    const width = KP.num(slope.width);
    const fullWidth = KP.num(material.fullWidth) || KP.num(material.usefulWidth) || 1;
    const usefulWidth = KP.num(material.usefulWidth) || fullWidth;
    const rounding = KP.num(slope.rounding);

    const columns = KP.columnCount(slope, usefulWidth);
    const pieces = [];
    let fullLength = 0;
    let usefulLength = 0;

    for (let i = 0; i < columns; i++) {
      const x0 = i * usefulWidth;
      const x1 = Math.min(width, (i + 1) * usefulWidth);
      if (x1 - x0 <= 1e-9) continue;
      const xc = (x0 + x1) / 2;
      const height = KP.heightAt(slope, xc);
      if (height <= 1e-6) continue;
      usefulLength += height;
      const lengths = KP.applySheetDeltas(
        KP.sheetLengths(height, material, rounding),
        slope.sheetLengthDeltas,
        material
      );
      for (let r = 0; r < lengths.length; r++) {
        const length = lengths[r];
        fullLength += length;
        pieces.push({
          length: length,
          column: i + 1,
          row: r + 1,
          width: x1 - x0
        });
      }
    }

    const grouped = new Map();
    pieces.forEach(function (p) {
      const key = p.length.toFixed(3);
      if (!grouped.has(key)) grouped.set(key, { length: p.length, count: 0 });
      grouped.get(key).count += 1;
    });
    const list = Array.from(grouped.values()).sort(function (a, b) { return a.length - b.length; });

    const fullArea = pieces.reduce(function (sum, p) { return sum + p.length * fullWidth; }, 0);
    const usefulArea = pieces.reduce(function (sum, p) { return sum + p.length * usefulWidth; }, 0);
    const grossArea = KP.shapeArea(slope);
    const cutArea = Math.min(grossArea, KP.cutoutArea(slope));
    const slopeArea = Math.max(0, grossArea - cutArea);
    const waste = usefulArea > 0 ? (usefulArea - slopeArea) / usefulArea * 100 : 0;
    const cost = fullArea * (KP.num(material.price) || 0);

    return {
      columns: columns,
      pieces: pieces,
      list: list,
      sheetCount: pieces.length,
      slopeArea: slopeArea,
      figureArea: grossArea,
      cutArea: cutArea,
      fullArea: fullArea,
      usefulArea: usefulArea,
      fullLength: fullLength,
      usefulLength: usefulLength,
      waste: waste,
      cost: cost,
      fullWidth: fullWidth,
      usefulWidth: usefulWidth
    };
  };

  KP.calcProject = function (project) {
    const rows = project.slopes.map(function (slope) {
      const material = KP.getMaterial(project, slope.materialId);
      return Object.assign({ slope: slope, material: material }, KP.calcSlope(slope, material));
    });

    const totals = {
      area: 0,
      fullArea: 0,
      usefulArea: 0,
      fullLength: 0,
      usefulLength: 0,
      sheets: 0,
      waste: 0,
      materialCost: 0,
      elementCost: 0,
      total: 0
    };

    rows.forEach(function (r) {
      totals.area += r.slopeArea;
      totals.fullArea += r.fullArea;
      totals.usefulArea += r.usefulArea;
      totals.fullLength += r.fullLength;
      totals.usefulLength += r.usefulLength;
      totals.sheets += r.sheetCount;
      totals.materialCost += r.cost;
    });
    totals.waste = totals.usefulArea > 0 ? (totals.usefulArea - totals.area) / totals.usefulArea * 100 : 0;

    const usage = new Map();
    rows.forEach(function (r) {
      const id = r.material.id;
      if (!usage.has(id)) {
        usage.set(id, {
          material: r.material,
          sheets: 0,
          roofArea: 0,
          fullArea: 0,
          usefulArea: 0,
          fullLength: 0,
          usefulLength: 0,
          cost: 0,
          slopes: 0
        });
      }
      const u = usage.get(id);
      u.sheets += r.sheetCount;
      u.roofArea += r.slopeArea;
      u.fullArea += r.fullArea;
      u.usefulArea += r.usefulArea;
      u.fullLength += r.fullLength;
      u.usefulLength += r.usefulLength;
      u.cost += r.cost;
      u.slopes += 1;
    });

    project.elements.forEach(function (el) {
      totals.elementCost += KP.num(el.qty) * KP.num(el.price);
    });
    totals.total = totals.materialCost + totals.elementCost;

    return {
      rows: rows,
      totals: totals,
      usage: Array.from(usage.values())
    };
  };

  KP.statsRows = function (row) {
    return [
      { label: 'Длина ската, м', value: KP.fmt(row.slope.height) },
      { label: 'Ширина ската, м', value: KP.fmt(row.slope.width) },
      { label: 'Площадь ската, м²', value: KP.fmt(row.slopeArea) },
      { label: 'Площадь фигуры, м²', value: KP.fmt(row.figureArea) },
      { label: 'Полная площадь листов, м²', value: KP.fmt(row.fullArea) },
      { label: 'Полезная площадь листов, м²', value: KP.fmt(row.usefulArea) },
      { label: 'Процент отходов, %', value: KP.fmt(row.waste), warn: row.waste > 25 },
      { label: 'Листов, шт', value: String(row.sheetCount) },
      { label: 'Стоимость материала, ₽', value: KP.fmt(row.cost, 0) }
    ];
  };

  KP.shapeLabel = function (shape) {
    return {
      rect: 'Прямоугольник',
      trapezoid: 'Трапеция',
      triangle: 'Треугольник',
      polygon: 'Многоугольник'
    }[shape] || 'Прямоугольник';
  };
})();
