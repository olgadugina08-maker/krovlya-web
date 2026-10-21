/* Интерфейс приложения */
(function () {
  const KP = window.KP;

  const $ = function (selector) { return document.querySelector(selector); };
  const $$ = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };

  let project = KP.load() || KP.newProject();
  let selectedId = project.slopes.length ? project.slopes[0].id : null;
  let selectedObjectId = null;
  let activeType = 'tile';
  let activeMaterialId = (project.materials.find(function (m) { return m.type === activeType; }) || project.materials[0] || {}).id || null;
  let canvasApi = null;
  let bottomPinned = false;
  let bottomTabName = 'spec';
  let installPrompt = null;
  const BOTTOM_UI_KEY = 'krovlya-bottom-panel-v1';

  // PWA: сохраняем событие установки, чтобы предложить её из меню.
  window.addEventListener('beforeinstallprompt', function (ev) {
    ev.preventDefault();
    installPrompt = ev;
  });

  const canvasWrap = $('#canvasWrap');
  const modalRoot = $('#modalRoot');
  const templatesMenu = $('#templatesMenu');

  function selectedSlope() {
    return project.slopes.find(function (s) { return s.id === selectedId; }) || null;
  }

  // Единый формат названий: «Скат №1», «Скат №2» и т. д.
  function nextSlopeName() {
    let max = 0;
    (project.slopes || []).forEach(function (slope) {
      const match = String(slope.name || '').match(/(\d+)/);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    });
    return 'Скат №' + Math.max(max + 1, (project.slopes || []).length + 1);
  }

  // Зазор между скатами в автоматической раскладке (как в canvas.js).
  const AUTO_SLOPE_GAP = 2.2;

  // Габарит ската на холсте с учётом сдвига и поворота.
  function slopeWorldBox(slope, x, y) {
    let points = KP.slopePoints(slope).map(function (p) {
      return [x + p[0], y + p[1]];
    });
    if (!points.length) {
      const w = Math.max(0.2, KP.num(slope.width));
      const h = Math.max(0.2, KP.num(slope.height));
      return { minX: x, minY: y, maxX: x + w, maxY: y + h };
    }
    if (slope.rotation && slope.renderOrigin) {
      const angle = slope.rotation * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const origin = slope.renderOrigin;
      points = points.map(function (p) {
        const dx = p[0] - origin.x;
        const dy = p[1] - origin.y;
        return [
          origin.x + dx * cos - dy * sin,
          origin.y + dx * sin + dy * cos
        ];
      });
    }
    const xs = points.map(function (p) { return p[0]; });
    const ys = points.map(function (p) { return p[1]; });
    return {
      minX: Math.min.apply(null, xs),
      minY: Math.min.apply(null, ys),
      maxX: Math.max.apply(null, xs),
      maxY: Math.max.apply(null, ys)
    };
  }

  // Подбираем новому скату свободное место справа, если базовое место
  // занято ранее сдвинутым вручную (или вставленным из DWG) скатом.
  function placeSlopeClearOfOthers(slope) {
    if (!slope || slope.inPlace) return;
    const w = Math.max(0.2, KP.num(slope.width));
    const h = Math.max(0.2, KP.num(slope.height));
    let cursor = 0;
    const boxes = [];
    (project.slopes || []).forEach(function (s) {
      if (s === slope) return;
      const sw = Math.max(0.2, KP.num(s.width));
      const inPlace = !!s.inPlace && s.anchor &&
        Number.isFinite(Number(s.anchor.x)) && Number.isFinite(Number(s.anchor.y));
      const offset = s.dragOffset || {};
      const ox = Number.isFinite(Number(offset.x)) ? Number(offset.x) : 0;
      const oy = Number.isFinite(Number(offset.y)) ? Number(offset.y) : 0;
      const x = (inPlace ? Number(s.anchor.x) : cursor) + ox;
      const y = (inPlace ? Number(s.anchor.y) : 0) + oy;
      boxes.push(slopeWorldBox(s, x, y));
      if (!inPlace) cursor += sw + AUTO_SLOPE_GAP;
    });

    const baseX = cursor;
    let x = baseX;
    // Сдвигаем кандидата вправо, пока он пересекается с существующими
    // скатами; зазор при сдвиге — как в обычной раскладке.
    for (let guard = 0; guard <= boxes.length; guard += 1) {
      let moved = false;
      boxes.forEach(function (b) {
        if (x < b.maxX && x + w > b.minX && 0 < b.maxY && h > b.minY) {
          x = b.maxX + AUTO_SLOPE_GAP;
          moved = true;
        }
      });
      if (!moved) break;
    }
    slope.dragOffset = {
      x: Number((x - baseX).toFixed(3)),
      y: 0
    };
  }

  function selectedDrawingObject() {
    return (project.objects || []).find(function (o) { return o.id === selectedObjectId; }) || null;
  }

  function objectKindLabel(kind) {
    if (kind === 'circle') return 'Окружность';
    if (kind === 'text') return 'Текст';
    if (kind === 'line') return 'Линия';
    return 'Полилиния';
  }

  function objectMeta(obj) {
    if (!obj) return '';
    if (obj.kind === 'circle') {
      return 'R ' + KP.fmt(obj.r) + ' м · центр ' + KP.fmt(obj.cx) + '; ' + KP.fmt(obj.cy);
    }
    if (obj.kind === 'text') {
      return 'h ' + KP.fmt(obj.height) + ' м · ' + KP.fmt(obj.x) + '; ' + KP.fmt(obj.y);
    }
    const count = (obj.points || []).length;
    return count + ' точек' + (isObjectClosed(obj) ? ' · замкнут' : '') + ' · слой ' + (obj.layer || '0');
  }

  function isObjectClosed(obj) {
    if (!obj || !Array.isArray(obj.points) || obj.points.length < 3) return false;
    if (obj.closed) return true;
    const first = obj.points[0];
    const last = obj.points[obj.points.length - 1];
    const xs = obj.points.map(function (p) { return p.x; });
    const ys = obj.points.map(function (p) { return p.y; });
    const diagonal = Math.hypot(
      Math.max.apply(null, xs) - Math.min.apply(null, xs),
      Math.max.apply(null, ys) - Math.min.apply(null, ys)
    );
    return Math.hypot(first.x - last.x, first.y - last.y) <= Math.max(0.001, diagonal * 0.002);
  }

  function persist() {
    KP.save(project);
  }

  function numericInput(value) {
    const n = KP.num(value);
    return Number(n.toFixed(3));
  }

  function escText(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function materialOptionList(selected) {
    const groups = {};
    project.materials.forEach(function (m) {
      if (!groups[m.type]) groups[m.type] = [];
      groups[m.type].push(m);
    });
    return Object.keys(groups).map(function (type) {
      const label = (KP.TYPES[type] || {}).label || type;
      return '<optgroup label="' + label + '">' + groups[type].map(function (m) {
        return '<option value="' + m.id + '"' + (m.id === selected ? ' selected' : '') + '>' +
          m.name + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }

  /* ---------- материалы ---------- */

  function renderMaterialTabs() {
    const tabs = $('#materialTabs');
    tabs.innerHTML = Object.keys(KP.TYPES).map(function (type) {
      return '<button class="' + (type === activeType ? 'active' : '') + '" data-type="' + type + '">' +
        KP.TYPES[type].label + '</button>';
    }).join('');
    tabs.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeType = btn.getAttribute('data-type');
        const first = project.materials.find(function (m) { return m.type === activeType; });
        if (first) activeMaterialId = first.id;
        renderAll();
      });
    });
  }

  function renderMaterials() {
    renderMaterialTabs();
    const list = $('#materialsList');
    const items = project.materials.filter(function (m) { return m.type === activeType; });
    if (!items.length) {
      list.innerHTML = '<p class="panel-note">Нет материалов этого типа. Добавьте материал кнопкой «+».</p>';
      return;
    }
    list.innerHTML = items.map(function (m) {
      const sourceBits = [];
      if (m.nomenclatureCode) sourceBits.push('Номер расчёта ' + escText(m.nomenclatureCode));
      if (m.coating) sourceBits.push(escText(m.coating));
      if (m.calcType) sourceBits.push(escText(m.calcType));
      return '<div class="mat-item ' + (m.id === activeMaterialId ? 'active' : '') + '" data-id="' + m.id + '">' +
        '<div class="mat-name">' + m.name + '</div>' +
        '<div class="mat-meta">Полная ' + KP.fmt(m.fullWidth) + ' / полезная ' + KP.fmt(m.usefulWidth) +
        ' м · ' + KP.fmt(m.price, 0) + ' ₽/м²</div>' +
        '<div class="mat-meta">' + (m.color || '—') + (m.waveStep ? ' · шаг ' + Math.round(KP.num(m.waveStep) * 1000) + ' мм' : '') + '</div>' +
        (sourceBits.length ? '<div class="mat-meta">' + sourceBits.join(' · ') + '</div>' : '') +
        '<div class="mat-actions">' +
          '<button data-edit="' + m.id + '">Изменить</button>' +
          '<button data-delete="' + m.id + '">Удалить</button>' +
        '</div>' +
      '</div>';
    }).join('');

    list.querySelectorAll('.mat-item').forEach(function (item) {
      item.addEventListener('click', function (ev) {
        if (ev.target.closest('button')) return;
        activeMaterialId = item.getAttribute('data-id');
        renderMaterials();
      });
    });
    list.querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openMaterialModal(btn.getAttribute('data-edit'));
      });
    });
    list.querySelectorAll('[data-delete]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        deleteMaterial(btn.getAttribute('data-delete'));
      });
    });
  }

  function deleteMaterial(id) {
    const used = project.slopes.some(function (s) { return s.materialId === id; });
    if (used) {
      alert('Материал используется в скатах. Сначала назначьте скатам другой материал.');
      return;
    }
    const material = project.materials.find(function (m) { return m.id === id; });
    if (!material) return;
    if (!confirm('Удалить материал «' + material.name + '»?')) return;
    project.materials = project.materials.filter(function (m) { return m.id !== id; });
    if (activeMaterialId === id) {
      const next = project.materials.find(function (m) { return m.type === activeType; });
      activeMaterialId = next ? next.id : null;
    }
    renderAll();
  }

  function openMaterialModal(id) {
    const existing = id ? project.materials.find(function (m) { return m.id === id; }) : null;
    const fallbackSource = KP.defaultMaterialSource(activeType, '', '');
    const material = existing || {
      type: activeType,
      name: '',
      fullWidth: 1.19,
      usefulWidth: 1.10,
      maxLength: 6,
      minLength: 0.5,
      price: 700,
      color: '',
      waveStep: 0.35,
      thickness: 0.5,
      forbiddenLengths: KP.defaultForbiddenLengths(activeType),
      nomenclatureCode: fallbackSource.nomenclatureCode,
      calcType: fallbackSource.calcType,
      coating: fallbackSource.coating,
      lockOverlap: fallbackSource.lockOverlap,
      roundingMm: fallbackSource.roundingMm,
      eaveOverhang: fallbackSource.eaveOverhang,
      trimAllowance: fallbackSource.trimAllowance,
      allowedLengths: fallbackSource.allowedLengths
    };
    const isEdit = !!existing;

    const body =
      '<div class="form-grid">' +
        '<div class="form-section-title">Исходные данные</div>' +
        '<div class="field"><label>Тип материала</label><select id="mType">' +
          Object.keys(KP.TYPES).map(function (type) {
            return '<option value="' + type + '"' + (type === material.type ? ' selected' : '') + '>' +
              KP.TYPES[type].label + '</option>';
          }).join('') +
        '</select></div>' +
        '<div class="field"><label>Название</label><input id="mName" type="text" value="' + String(material.name).replace(/"/g, '&quot;') + '"></div>' +
        '<div class="field"><label>Номер расчёта</label><input id="mCode" type="text" value="' + escText(material.nomenclatureCode || '') + '"></div>' +
        '<div class="field"><label>Тип расчёта продукции</label><input id="mCalcType" type="text" value="' + escText(material.calcType || '') + '"></div>' +
        '<div class="field"><label>Покрытие</label><input id="mCoating" type="text" value="' + escText(material.coating || '') + '"></div>' +
        '<div class="field"><label>Цвет / фактура</label><input id="mColor" type="text" value="' + escText(material.color || '') + '"></div>' +
        '<div class="field"><label>Полная ширина, мм</label><input id="mFull" type="number" step="1" min="1" value="' + Math.round(KP.num(material.fullWidth) * 1000) + '"></div>' +
        '<div class="field"><label>Полезная ширина, мм</label><input id="mUseful" type="number" step="1" min="1" value="' + Math.round(KP.num(material.usefulWidth) * 1000) + '"></div>' +
        '<div class="field"><label>Перекрытие замковое, мм</label><input id="mOverlap" type="number" step="1" min="0" value="' + Math.round(KP.num(material.lockOverlap) || 0) + '"></div>' +
        '<div class="field"><label>Величина карнизного свеса, мм</label><input id="mEave" type="number" step="1" min="0" value="' + Math.round(KP.num(material.eaveOverhang) || 0) + '"></div>' +
        '<div class="field"><label>Шаг волны, мм</label><input id="mWave" type="number" step="1" min="0" value="' + Math.round(KP.num(material.waveStep) * 1000) + '"></div>' +
        '<div class="field"><label>Припуск на подрезку, мм</label><input id="mTrim" type="number" step="5" min="0" value="' + Math.round(KP.num(material.trimAllowance) || 0) + '"></div>' +
        '<div class="field"><label>Толщина, мм</label><input id="mThick" type="number" step="0.05" min="0" value="' + material.thickness + '"></div>' +
        '<div class="field"><label>Длина min, мм</label><input id="mMin" type="number" step="1" min="0" value="' + Math.round(KP.num(material.minLength) * 1000) + '"></div>' +
        '<div class="field"><label>Длина max, мм</label><input id="mMax" type="number" step="1" min="1" value="' + Math.round(KP.num(material.maxLength) * 1000) + '"></div>' +
        '<div class="field"><label>Округление, мм</label><input id="mRound" type="number" step="1" min="0" value="' + Math.round(KP.num(material.roundingMm) || 0) + '"></div>' +
        '<div class="field full"><label>Допустимые размеры, м</label>' +
          '<div class="range-table-wrap"><table class="range-table" id="mAllowedTable"><thead><tr>' +
            '<th>От, м</th><th>До, м</th><th></th></tr></thead><tbody></tbody></table></div>' +
          '<div class="prop-actions"><button type="button" class="btn ghost small" id="mAddRange">+ Добавить диапазон</button></div>' +
          '<p class="shape-hint">Диапазоны допустимых длин листов по справочнику производителя (без учёта округления, минимума и максимума).</p></div>' +
        '<div class="form-section-title">Расчёт и ограничения</div>' +
        '<div class="field"><label>Цена, ₽/м²</label><input id="mPrice" type="number" step="1" min="0" value="' + material.price + '"></div>' +
        '<div class="field full"><label>Недопустимые длины, м</label>' +
          '<div class="range-table-wrap"><table class="range-table" id="mForbiddenTable"><thead><tr>' +
            '<th>От, м</th><th>До, м</th><th></th></tr></thead><tbody></tbody></table></div>' +
          '<div class="prop-actions"><button type="button" class="btn ghost small" id="mAddForbiddenRange">+ Добавить диапазон</button></div>' +
        '</div>' +
      '</div>';

    let allowedEditor = null;
    let forbiddenEditor = null;

    openModal(isEdit ? 'Редактирование материала' : 'Новый материал', body, function () {
      const name = $('#mName').value.trim();
      const fullMm = KP.num($('#mFull').value);
      const usefulMm = KP.num($('#mUseful').value);
      const full = fullMm / 1000;
      const useful = usefulMm / 1000;
      if (!name) { alert('Укажите название материала.'); return false; }
      if (full <= 0 || useful <= 0) { alert('Ширина должна быть больше нуля.'); return false; }
      if (useful > full) { alert('Полезная ширина не может быть больше полной.'); return false; }

      const maxMm = KP.num($('#mMax').value);
      const minMm = KP.num($('#mMin').value);
      const allowedResult = allowedEditor ? allowedEditor.getRows() : { ranges: [], invalid: false };
      if (allowedResult.invalid) {
        alert('Проверьте допустимые размеры: «От» и «До» должны быть числами, «До» не меньше «От».');
        return false;
      }
      const forbiddenResult = forbiddenEditor ? forbiddenEditor.getRows() : { ranges: [], invalid: false };
      if (forbiddenResult.invalid) {
        alert('Проверьте недопустимые длины: «От» и «До» должны быть числами, «До» не меньше «От».');
        return false;
      }
      const data = {
        id: existing ? existing.id : KP.uid('mat'),
        type: $('#mType').value,
        name: name,
        fullWidth: full,
        usefulWidth: useful,
        maxLength: maxMm > 0 ? maxMm / 1000 : 6,
        minLength: minMm > 0 ? minMm / 1000 : 0,
        forbiddenLengths: KP.formatLengthRanges(forbiddenResult.ranges),
        nomenclatureCode: $('#mCode').value.trim(),
        calcType: $('#mCalcType').value.trim(),
        coating: $('#mCoating').value.trim(),
        lockOverlap: Math.max(0, KP.num($('#mOverlap').value)) || 0,
        roundingMm: Math.max(0, KP.num($('#mRound').value)) || 0,
        eaveOverhang: Math.max(0, KP.num($('#mEave').value)) || 0,
        allowedLengths: KP.formatLengthRanges(allowedResult.ranges),
        price: KP.num($('#mPrice').value) || 0,
        color: $('#mColor').value.trim(),
        waveStep: Number(((KP.num($('#mWave').value) || 0) / 1000).toFixed(3)),
        trimAllowance: Math.max(0, KP.num($('#mTrim').value)) || 0,
        thickness: KP.num($('#mThick').value) || 0
      };

      if (existing) {
        const index = project.materials.findIndex(function (m) { return m.id === existing.id; });
        project.materials[index] = data;
      } else {
        project.materials.push(data);
      }
      activeType = data.type;
      activeMaterialId = data.id;
      renderAll();
      return true;
    });

    function createRangeEditor(tableId, addButtonId, initialText) {
      const body = $('#' + tableId + ' tbody');
      const addButton = $('#' + addButtonId);
      const display = function (value) {
        return value === '' || value == null ? '' : String(value).replace('.', ',');
      };
      const addRow = function (from, to) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td><input type="text" inputmode="decimal" data-range-from value="' + display(from) + '"></td>' +
          '<td><input type="text" inputmode="decimal" data-range-to value="' + display(to) + '"></td>' +
          '<td><button type="button" class="icon-btn" data-del-range title="Удалить диапазон">×</button></td>';
        body.appendChild(tr);
        tr.querySelector('[data-del-range]').addEventListener('click', function () {
          tr.parentNode.removeChild(tr);
        });
      };
      const setValue = function (text) {
        body.innerHTML = '';
        KP.parseLengthRanges(text || '').forEach(function (range) {
          addRow(range.from, range.to);
        });
        if (!body.children.length) addRow('', '');
      };
      const getRows = function () {
        const ranges = [];
        let invalid = false;
        body.querySelectorAll('tr').forEach(function (tr) {
          const fromInput = tr.querySelector('[data-range-from]');
          const toInput = tr.querySelector('[data-range-to]');
          const fromText = fromInput.value.trim();
          const toText = toInput.value.trim();
          if (!fromText && !toText) return;
          const from = KP.num(fromText);
          const to = KP.num(toText);
          if (!(from > 0) || !(to >= from)) {
            invalid = true;
            return;
          }
          ranges.push({ from: from, to: to });
        });
        ranges.sort(function (a, b) { return a.from - b.from; });
        return { ranges: ranges, invalid: invalid };
      };
      const getText = function () {
        return KP.formatLengthRanges(getRows().ranges);
      };
      if (addButton) {
        addButton.addEventListener('click', function () {
          addRow('', '');
          const rows = body.querySelectorAll('tr');
          const lastInput = rows[rows.length - 1] && rows[rows.length - 1].querySelector('[data-range-from]');
          if (lastInput) lastInput.focus();
        });
      }
      setValue(initialText);
      return { getRows: getRows, getText: getText, setValue: setValue };
    }

    allowedEditor = createRangeEditor('mAllowedTable', 'mAddRange', material.allowedLengths || '');
    forbiddenEditor = createRangeEditor('mForbiddenTable', 'mAddForbiddenRange', material.forbiddenLengths || '');

    const typeSelect = $('#mType');
    if (typeSelect) {
      typeSelect.addEventListener('change', function () {
        if (forbiddenEditor) {
          const current = forbiddenEditor.getText();
          if (!current || current === KP.defaultForbiddenLengths(material.type)) {
            forbiddenEditor.setValue(KP.defaultForbiddenLengths(typeSelect.value));
          }
        }
        const calcType = $('#mCalcType');
        if (calcType && !calcType.value.trim()) {
          calcType.value = KP.defaultMaterialSource(typeSelect.value, '', '').calcType;
        }
      });
    }
  }

  function openModal(title, bodyHtml, onSave, options) {
    const wide = options && options.wide ? ' modal-wide' : '';
    modalRoot.innerHTML =
      '<div class="modal-backdrop">' +
        '<div class="modal' + wide + '" role="dialog" aria-modal="true">' +
          '<div class="modal-head"><h3>' + title + '</h3>' +
            '<button class="icon-btn" data-close="1" title="Закрыть">×</button></div>' +
          '<div class="modal-body">' + bodyHtml + '</div>' +
          '<div class="modal-foot">' +
            '<button class="btn ghost" data-close="1">Отмена</button>' +
            '<button class="btn" data-save="1">Сохранить</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    function close() { modalRoot.innerHTML = ''; }

    modalRoot.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', close);
    });
    modalRoot.querySelector('.modal-backdrop').addEventListener('mousedown', function (ev) {
      if (ev.target === ev.currentTarget) close();
    });
    const saveButton = modalRoot.querySelector('[data-save]');
    if (options && options.saveLabel) saveButton.textContent = options.saveLabel;
    saveButton.addEventListener('click', function () {
      if (onSave() !== false) close();
    });
    const firstInput = modalRoot.querySelector('input, select');
    if (firstInput) firstInput.focus();
  }

  /* ---------- свойства ската ---------- */

  function edgeTypeOptions(selected) {
    return Object.keys(KP.edgeTypeLabels).map(function (key) {
      return '<option value="' + key + '"' + (key === selected ? ' selected' : '') + '>' +
        escText(KP.edgeTypeLabels[key]) + '</option>';
    }).join('');
  }

  function edgeTypeSectionHtml(slope) {
    if (!slope || slope.shape !== 'polygon') return '';
    const points = KP.slopePoints(slope).map(function (p) { return { x: p[0], y: p[1] }; });
    if (points.length < 3) return '';
    const edges = contourEdges(points);
    const types = ensureSlopeEdgeTypes(slope);
    if (!edges.length) return '';
    return '<div class="prop-section-title">Стороны ската</div>' +
      '<div class="edge-type-list">' +
        edges.map(function (edge) {
          return '<div class="edge-type-row">' +
            '<span class="edge-type-name">Сторона ' + (edge.index + 1) + ' · ' +
              KP.fmt(edge.length) + ' м</span>' +
            '<select data-edge-type="' + edge.index + '">' +
              edgeTypeOptions(types[edge.index] || 'rib') +
            '</select>' +
          '</div>';
        }).join('') +
      '</div>';
  }

  function axisLayoutSectionHtml(slope, points, edges, types) {
    if (!slope || slope.layoutMode !== 'axis') return '';
    let candidates = edges.filter(function (edge) {
      return types[edge.index] === 'rib' || types[edge.index] === 'valley';
    });
    if (!candidates.length) candidates = edges;
    let axis = slope.axisEdge;
    if (!candidates.some(function (edge) { return edge.index === axis; })) {
      axis = candidates[0] ? candidates[0].index : null;
    }
    const orientation = slope.axisOrientation === 'horizontal' ? 'horizontal' : 'vertical';
    return '<div class="prop-section-title">Раскладка без карниза и конька</div>' +
      '<div class="prop-row"><label>Ось раскладки</label><select id="sAxisEdge">' +
        candidates.map(function (edge) {
          return '<option value="' + edge.index + '"' + (edge.index === axis ? ' selected' : '') + '>' +
            'Сторона ' + (edge.index + 1) + ' · ' + KP.fmt(edge.length) + ' м</option>';
        }).join('') +
      '</select></div>' +
      '<div class="prop-row"><label>Направление</label><select id="sAxisOrientation">' +
        '<option value="vertical"' + (orientation === 'vertical' ? ' selected' : '') + '>Вертикально</option>' +
        '<option value="horizontal"' + (orientation === 'horizontal' ? ' selected' : '') + '>Горизонтально</option>' +
      '</select></div>' +
      '<label class="check-row"><input id="sLayoutMirror" type="checkbox"' +
        (slope.layoutMirror ? ' checked' : '') + '> Зеркально</label>';
  }

  function rebuildAxisSlope(slope) {
    const object = (project.objects || []).find(function (o) { return o.id === slope.sourceObjectId; });
    const types = ensureSlopeEdgeTypes(slope).slice();
    if (!object || !slope.inPlace) {
      renderAll();
      return;
    }
    const updated = createAxisSlopeFromObject(object, {
      axisEdge: slope.axisEdge,
      axisOrientation: slope.axisOrientation,
      layoutMirror: slope.layoutMirror,
      startEdge: slope.layoutStartEdge,
      edgeTypes: types
    });
    if (updated) {
      updated.edgeTypes = types;
      updated.layoutMode = 'axis';
    }
    renderAll();
  }

  function setSlopeEdgeType(slope, index, type) {
    if (!slope || slope.shape !== 'polygon' || !KP.edgeTypeLabels[type]) return;
    const types = ensureSlopeEdgeTypes(slope).slice();
    const previous = types[index] || 'rib';
    if (previous === type) return;
    if (previous === 'eave' && type !== 'eave' && type !== 'ridge') {
      alert('У ската должен остаться карниз. Сначала назначьте карниз другой стороне.');
      renderAll();
      return;
    }
    if (previous === 'ridge' && type !== 'ridge' && type !== 'eave') {
      alert('У ската должен остаться конёк. Сначала назначьте конёк другой стороне.');
      renderAll();
      return;
    }
    const oldEave = types.indexOf('eave');
    const oldRidge = types.indexOf('ridge');

    if (type === 'eave') {
      if (oldRidge === index) {
        if (oldEave >= 0 && oldEave !== index) {
          types[oldEave] = 'ridge';
          slope.ridgeEdge = oldEave;
        } else {
          slope.ridgeEdge = null;
        }
      } else if (oldEave >= 0 && oldEave !== index) {
        types[oldEave] = 'rib';
      }
      slope.eaveEdge = index;
    } else if (type === 'ridge') {
      if (oldEave === index) {
        if (oldRidge >= 0 && oldRidge !== index) {
          types[oldRidge] = 'eave';
          slope.eaveEdge = oldRidge;
        } else {
          slope.eaveEdge = null;
        }
      } else if (oldRidge >= 0 && oldRidge !== index) {
        types[oldRidge] = 'rib';
      }
      slope.ridgeEdge = index;
    } else {
      if (oldEave === index) slope.eaveEdge = null;
      if (oldRidge === index) slope.ridgeEdge = null;
    }
    types[index] = type;
    slope.edgeTypes = types;

    const object = (project.objects || []).find(function (o) { return o.id === slope.sourceObjectId; });
    if (slope.layoutMode === 'manual') {
      if (object && slope.inPlace) {
        applyManualDirection(slope, Number(slope.layoutAngle) || 0, !!slope.layoutMirror);
      } else {
        renderAll();
      }
      return;
    }
    const edgeMode = Number.isInteger(slope.eaveEdge) && Number.isInteger(slope.ridgeEdge) &&
      slope.eaveEdge !== slope.ridgeEdge;

    slope.layoutMode = 'edge';
    if (edgeMode && object && slope.inPlace) {
      const updated = createSlopeFromObject(object, {
        eaveEdge: slope.eaveEdge,
        ridgeEdge: slope.ridgeEdge,
        startEdge: slope.layoutStartEdge,
        layoutMirror: slope.layoutMirror,
        edgeTypes: types
      });
      if (updated) updated.edgeTypes = types.slice();
    }
    renderAll();
  }

  function layoutDirectionSectionHtml(slope) {
    if (!slope || slope.shape !== 'polygon' || !slope.sourceObjectId) return '';
    const manual = slope.layoutMode === 'manual';
    const angle = manual && Number.isFinite(Number(slope.layoutAngle))
      ? Number(slope.layoutAngle)
      : 90;
    return '<div class="prop-section-title">Направление раскладки</div>' +
      '<div class="prop-row"><label>Режим</label><select id="sLayoutMode">' +
        '<option value="edge"' + (!manual ? ' selected' : '') + '>От карниза</option>' +
        '<option value="manual"' + (manual ? ' selected' : '') + '>Вручную</option>' +
      '</select></div>' +
      (manual
        ? '<div class="prop-row"><label>Угол, °</label><input id="sLayoutAngle" type="number" step="1" min="0" max="360" value="' +
            Number(angle.toFixed(1)) + '"></div>' +
          '<div class="prop-actions"><button class="btn ghost small" id="sLayoutAngle90">Повернуть на 90°</button></div>' +
          '<label class="check-row"><input id="sLayoutMirror" type="checkbox"' +
            (slope.layoutMirror ? ' checked' : '') + '> Зеркально</label>' +
          '<div class="prop-actions"><button class="btn ghost small" id="sPickDirection">Указать на чертеже</button></div>' +
          '<p class="shape-hint">0° — вправо, 90° — вниз. Листы идут от линии старта в заданном направлении.</p>'
        : '');
  }

  function layoutSourceObject(slope) {
    return (project.objects || []).find(function (o) { return o.id === slope.sourceObjectId; }) || null;
  }

  function applyManualDirection(slope, angle, mirror) {
    const object = layoutSourceObject(slope);
    if (!object) {
      alert('Исходный объект DWG не найден.');
      return;
    }
    const types = ensureSlopeEdgeTypes(slope).slice();
    const updated = createManualSlopeFromObject(object, {
      layoutAngle: angle,
      layoutMirror: mirror,
      edgeTypes: types
    });
    if (updated) {
      updated.edgeTypes = types;
      selectedId = updated.id;
    }
    renderAll();
  }

  function switchSlopeLayoutMode(slope, mode) {
    const object = layoutSourceObject(slope);
    if (!object) {
      alert('Исходный объект DWG не найден.');
      return;
    }
    const types = ensureSlopeEdgeTypes(slope).slice();
    if (mode === 'manual') {
      applyManualDirection(slope, Number.isFinite(Number(slope.layoutAngle)) ? slope.layoutAngle : 90, slope.layoutMirror);
      return;
    }
    let eave = Number.isInteger(slope.eaveEdge) ? slope.eaveEdge : null;
    let ridge = Number.isInteger(slope.ridgeEdge) ? slope.ridgeEdge : null;
    if (eave == null || ridge == null || eave === ridge) {
      const auto = autoOrientation(object);
      eave = auto ? auto.eaveEdge : 0;
      ridge = auto ? auto.ridgeEdge : 1;
    }
    const updated = createSlopeFromObject(object, {
      eaveEdge: eave,
      ridgeEdge: ridge,
      startEdge: slope.layoutStartEdge,
      edgeTypes: types
    });
    if (updated) {
      updated.edgeTypes = types;
      selectedId = updated.id;
    }
    renderAll();
  }

  // Порядок листов: слева направо или справа налево.
  function setSlopeLayoutOrder(slope, rightToLeft) {
    if (!slope) return;
    const mirror = !!slope.layoutMirror;
    slope.layoutStart = rightToLeft
      ? (mirror ? 'left' : 'right')
      : (mirror ? 'right' : 'left');
    // Для скатов из DWG сохраняем согласованную стартовую кромку,
    // чтобы порядок не сбрасывался при перестроении раскладки.
    if (slope.shape === 'polygon' && Number.isInteger(Number(slope.eaveEdge))) {
      const points = KP.slopePoints(slope);
      const edgeIndex = Number(slope.eaveEdge);
      const a = points[edgeIndex];
      const b = points[(edgeIndex + 1) % points.length];
      if (a && b && edgeIndex >= 0 && edgeIndex < points.length) {
        const eaveStartsAtLeft = a[0] < b[0];
        const wantLeft = slope.layoutStart === 'left';
        slope.layoutStartEdge = eaveStartsAtLeft ? wantLeft : !wantLeft;
      }
    }
    renderAll();
  }

  function sheetLengthsSectionHtml(slope, material) {
    if (!slope || !material) return '';
    const base = KP.sheetLengths(KP.num(slope.height), material, KP.num(slope.rounding));
    const lengths = KP.applySheetDeltas(base, slope.sheetLengthDeltas, material);
    if (!lengths.length) return '';
    const step = KP.num(material.waveStep);
    const canAdjust = step > 0 && lengths.length > 1;
    const deltas = Array.isArray(slope.sheetLengthDeltas) ? slope.sheetLengthDeltas : [];
    const hasDeltas = deltas.some(function (value) { return Math.abs(KP.num(value)) > 1e-9; });
    const hint = step <= 0
      ? 'В справочнике материалов не задан шаг волны — ручное изменение недоступно.'
      : (lengths.length < 2
        ? 'У ската один лист по высоте — компенсировать длину нечем.'
        : 'Шаг изменения — ' + Math.round(step * 1000) + ' мм (длина волны). Соседний лист автоматически компенсирует длину, нахлёст сохраняется.');
    return '<div class="prop-section-title">Длины листов</div>' +
      '<div class="sheet-length-list">' + lengths.map(function (length, index) {
        const isBottom = index === 0;
        const isTop = index === lengths.length - 1;
        const label = lengths.length === 1
          ? 'Лист'
          : 'Ряд ' + (index + 1) + (isBottom ? ' · карниз' : (isTop ? ' · конёк' : ''));
        return '<div class="sheet-length-row">' +
          '<span class="sheet-length-label">' + label + '</span>' +
          '<span class="sheet-length-value">' + KP.fmt(length, 3) + ' м</span>' +
          '<button type="button" class="icon-btn" data-sheet-step="-1" data-sheet-row="' + index + '" title="Укоротить на шаг волны"' + (canAdjust ? '' : ' disabled') + '>−</button>' +
          '<button type="button" class="icon-btn" data-sheet-step="1" data-sheet-row="' + index + '" title="Удлинить на шаг волны"' + (canAdjust ? '' : ' disabled') + '>+</button>' +
        '</div>';
      }).join('') + '</div>' +
      '<p class="shape-hint">' + hint + '</p>' +
      (hasDeltas
        ? '<div class="prop-actions"><button type="button" class="btn ghost small" id="sSheetReset">Сбросить длины листов</button></div>'
        : '');
  }

  function adjustSheetLength(slope, rowIndex, direction) {
    if (!slope || (direction !== 1 && direction !== -1)) return;
    const material = KP.getMaterial(project, slope.materialId);
    if (!material) return;
    const step = KP.num(material.waveStep);
    if (!(step > 0)) {
      alert('В справочнике материалов не задан шаг волны.');
      return;
    }
    const base = KP.sheetLengths(KP.num(slope.height), material, KP.num(slope.rounding));
    if (base.length < 2) {
      alert('У ската один лист по высоте — компенсировать длину нечем.');
      return;
    }
    if (!(rowIndex >= 0 && rowIndex < base.length)) return;
    const deltas = (Array.isArray(slope.sheetLengthDeltas) ? slope.sheetLengthDeltas.slice() : []);
    while (deltas.length < base.length) deltas.push(0);
    const neighbor = rowIndex + 1 < base.length ? rowIndex + 1 : rowIndex - 1;
    if (neighbor < 0 || neighbor >= base.length) return;
    const current = KP.applySheetDeltas(base, deltas, material);
    const minLength = Math.max(0.01, KP.num(material.minLength));
    const maxLength = KP.num(material.maxLength) || 6;
    const target = current[rowIndex] + direction * step;
    const neighborLength = current[neighbor] - direction * step;
    if (target > maxLength + 1e-9 || target < minLength - 1e-9 ||
        neighborLength > maxLength + 1e-9 || neighborLength < minLength - 1e-9) {
      alert('Нельзя изменить длину: лист выйдет за допустимые пределы.');
      return;
    }
    deltas[rowIndex] = Number((KP.num(deltas[rowIndex]) + direction * step).toFixed(3));
    deltas[neighbor] = Number((KP.num(deltas[neighbor]) - direction * step).toFixed(3));
    slope.sheetLengthDeltas = deltas;
    renderAll();
  }

  function renderProps() {
    const object = selectedDrawingObject();
    if (object) {
      renderObjectProps(object);
      return;
    }
    const slope = selectedSlope();
    const box = $('#slopeProps');
    if (!slope) {
      box.innerHTML = '<p class="prop-empty">Скат или объект не выбран. Добавьте скат или выберите элемент на холсте.</p>';
      return;
    }
    if (slope.shape === 'polygon') ensureSlopeEdgeTypes(slope);
    const startRight = (slope.layoutStart === 'right') !== !!slope.layoutMirror;
    const material = KP.getMaterial(project, slope.materialId);

    box.innerHTML =
      '<div class="prop-row"><label>Название</label><input id="sName" type="text" value="' +
        String(slope.name).replace(/"/g, '&quot;') + '"></div>' +
      '<div class="prop-row"><label>Форма</label><select id="sShape">' +
        '<option value="rect"' + (slope.shape === 'rect' ? ' selected' : '') + '>Прямоугольник</option>' +
        '<option value="trapezoid"' + (slope.shape === 'trapezoid' ? ' selected' : '') + '>Трапеция</option>' +
        '<option value="triangle"' + (slope.shape === 'triangle' ? ' selected' : '') + '>Треугольник</option>' +
        '<option value="polygon"' + (slope.shape === 'polygon' ? ' selected' : '') + '>Многоугольник</option>' +
      '</select></div>' +
      '<div class="prop-row"><label>Материал</label><select id="sMaterial">' +
        materialOptionList(slope.materialId) + '</select></div>' +
      '<div class="prop-row"><label>Ширина, м</label><input id="sWidth" type="number" step="0.01" min="0.1" value="' + numericInput(slope.width) + '"></div>' +
      '<div class="prop-row"><label>Длина ската, м</label><input id="sHeight" type="number" step="0.01" min="0.1" value="' + numericInput(slope.height) + '"></div>' +
      (slope.shape === 'trapezoid'
        ? '<div class="prop-row"><label>Верхняя ширина, м</label><input id="sTop" type="number" step="0.01" min="0" value="' + numericInput(slope.topWidth) + '"></div>'
        : '') +
      '<div class="prop-row"><label>Угол, °</label><input id="sAngle" type="number" step="1" min="0" max="90" value="' + numericInput(slope.angle) + '"></div>' +
      '<div class="prop-row"><label>Округление длин</label><select id="sRounding">' +
        [0, 0.05, 0.1, 0.25].map(function (v) {
          return '<option value="' + v + '"' + (Math.abs(KP.num(slope.rounding) - v) < 1e-9 ? ' selected' : '') + '>' +
            (v ? KP.fmt(v) + ' м' : 'без округления') + '</option>';
        }).join('') +
      '</select></div>' +
      '<div class="prop-row prop-row-wide"><label>Порядок раскладки</label><select id="sLayoutOrder">' +
        '<option value="left"' + (!startRight ? ' selected' : '') + '>Слева направо</option>' +
        '<option value="right"' + (startRight ? ' selected' : '') + '>Справа налево</option>' +
      '</select></div>' +
      (material ? sheetLengthsSectionHtml(slope, material) : '') +
      (slope.layoutMode === 'edge' && slope.eaveEdge != null && slope.ridgeEdge != null
        ? '<div class="prop-row"><label>Ориентация</label><span class="prop-value">карниз — ребро ' +
          (slope.eaveEdge + 1) + ', конёк — ребро ' + (slope.ridgeEdge + 1) + '</span></div>'
        : '') +
      (Array.isArray(slope.cutouts) && slope.cutouts.length
        ? '<div class="prop-row"><label>Вырезы</label><span class="prop-value">' +
          slope.cutouts.length + ' шт. · ' + KP.fmt(KP.cutoutArea(slope)) + ' м²</span></div>'
        : '') +
      edgeTypeSectionHtml(slope) +
      layoutDirectionSectionHtml(slope) +
      '<div class="prop-actions prop-actions-compact">' +
        (slope.sourceObjectId
          ? '<button class="btn ghost small" id="sLayoutOrientation">Карниз и конёк…</button>'
          : '') +
        '<button class="btn ghost small" id="sCoords">Координаты…</button>' +
        '<button class="btn ghost small" id="sShapeDims">Размеры и форма…</button>' +
        '<button class="btn ghost small" id="sCutout">Добавить вырез</button>' +
        '<button class="btn ghost small" id="sDuplicate">Дублировать</button>' +
        '<button class="btn danger small" id="sDelete">Удалить скат</button>' +
      '</div>';

    $('#sName').addEventListener('change', function (ev) {
      slope.name = ev.target.value.trim() || 'Скат';
      renderAll();
    });
    $('#sShape').addEventListener('change', function (ev) {
      const next = ev.target.value;
      if (next === 'polygon') {
        const pts = KP.slopePoints({
          shape: slope.shape,
          width: slope.width,
          height: slope.height,
          topWidth: slope.topWidth,
          points: slope.points
        }).map(function (p) { return { x: p[0], y: p[1] }; });
        const norm = KP.normalizePoints(pts);
        slope.shape = 'polygon';
        slope.points = norm.points;
        slope.width = norm.width;
        slope.height = norm.height;
        slope.topWidth = 0;
      } else {
        slope.shape = next;
        slope.points = [];
        if (slope.shape === 'trapezoid' && (!slope.topWidth || slope.topWidth >= slope.width)) {
          slope.topWidth = Math.max(0.5, Number((slope.width * 0.6).toFixed(2)));
        }
        if (slope.shape !== 'trapezoid') slope.topWidth = 0;
      }
      slope.sheetLengthDeltas = [];
      renderAll();
    });
    $('#sMaterial').addEventListener('change', function (ev) {
      slope.materialId = ev.target.value;
      slope.sheetLengthDeltas = [];
      activeMaterialId = ev.target.value;
      renderAll();
    });
    $('#sWidth').addEventListener('change', function (ev) {
      const newWidth = Math.max(0.1, numericInput(ev.target.value));
      if (slope.shape === 'polygon' && Array.isArray(slope.points) && slope.points.length) {
        const k = newWidth / (KP.num(slope.width) || 1);
        slope.points = slope.points.map(function (p) {
          return { x: Number((p.x * k).toFixed(3)), y: p.y };
        });
      }
      slope.width = newWidth;
      if (slope.shape === 'trapezoid') slope.topWidth = Math.min(slope.topWidth, slope.width);
      renderAll();
    });
    $('#sHeight').addEventListener('change', function (ev) {
      const newHeight = Math.max(0.1, numericInput(ev.target.value));
      if (slope.shape === 'polygon' && Array.isArray(slope.points) && slope.points.length) {
        const k = newHeight / (KP.num(slope.height) || 1);
        slope.points = slope.points.map(function (p) {
          return { x: p.x, y: Number((p.y * k).toFixed(3)) };
        });
      }
      slope.height = newHeight;
      slope.sheetLengthDeltas = [];
      renderAll();
    });
    if ($('#sTop')) {
      $('#sTop').addEventListener('change', function (ev) {
        slope.topWidth = Math.max(0, Math.min(numericInput(ev.target.value), slope.width));
        slope.sheetLengthDeltas = [];
        renderAll();
      });
    }
    $('#sAngle').addEventListener('change', function (ev) {
      slope.angle = Math.max(0, Math.min(90, numericInput(ev.target.value)));
      renderAll();
    });
    $('#sRounding').addEventListener('change', function (ev) {
      slope.rounding = KP.num(ev.target.value);
      slope.sheetLengthDeltas = [];
      renderAll();
    });
    $('#sLayoutOrder').addEventListener('change', function (ev) {
      setSlopeLayoutOrder(slope, ev.target.value === 'right');
    });
    box.querySelectorAll('[data-sheet-step]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        adjustSheetLength(
          slope,
          parseInt(btn.getAttribute('data-sheet-row'), 10),
          parseInt(btn.getAttribute('data-sheet-step'), 10)
        );
      });
    });
    if ($('#sSheetReset')) {
      $('#sSheetReset').addEventListener('click', function () {
        slope.sheetLengthDeltas = [];
        renderAll();
      });
    }
    box.querySelectorAll('[data-edge-type]').forEach(function (select) {
      select.addEventListener('change', function (ev) {
        setSlopeEdgeType(slope, parseInt(ev.target.getAttribute('data-edge-type'), 10), ev.target.value);
      });
    });
    if ($('#sLayoutMode')) {
      $('#sLayoutMode').addEventListener('change', function (ev) {
        switchSlopeLayoutMode(slope, ev.target.value);
      });
    }
    if ($('#sLayoutAngle')) {
      $('#sLayoutAngle').addEventListener('change', function (ev) {
        const angle = ((KP.num(ev.target.value) % 360) + 360) % 360;
        applyManualDirection(slope, angle, !!slope.layoutMirror);
      });
    }
    if ($('#sLayoutAngle90')) {
      $('#sLayoutAngle90').addEventListener('click', function () {
        const angle = ((KP.num(slope.layoutAngle) + 90) % 360 + 360) % 360;
        applyManualDirection(slope, angle, !!slope.layoutMirror);
      });
    }
    if ($('#sLayoutMirror')) {
      $('#sLayoutMirror').addEventListener('change', function (ev) {
        applyManualDirection(slope, Number(slope.layoutAngle) || 0, !!ev.target.checked);
      });
    }
    if ($('#sPickDirection')) {
      $('#sPickDirection').addEventListener('click', function () {
        if (!canvasApi || !canvasApi.startDirectionPick) {
          alert('Указание направления на чертеже недоступно.');
          return;
        }
        canvasApi.startDirectionPick({
          onPick: function (result) {
            const angle = ((KP.num(result.angle) % 360) + 360) % 360;
            slope.layoutAngle = angle;
            applyManualDirection(slope, angle, !!slope.layoutMirror);
          }
        });
      });
    }
    if ($('#sLayoutOrientation')) {
      $('#sLayoutOrientation').addEventListener('click', function () {
        const object = (project.objects || []).find(function (o) { return o.id === slope.sourceObjectId; });
        if (!object) {
          alert('Исходный объект DWG не найден. Переимпортируйте чертёж или измените скат вручную.');
          return;
        }
        openLayoutOrientationModal(object);
      });
    }
    $('#sCoords').addEventListener('click', function () {
      openCoordsModal(slope);
    });
    $('#sShapeDims').addEventListener('click', function () {
      openShapeModal(slope);
    });
    $('#sCutout').addEventListener('click', function () {
      openCutoutModal(slope);
    });
    $('#sDuplicate').addEventListener('click', function () {
      const copy = KP.clone(slope);
      copy.id = KP.uid('slope');
      copy.name = nextSlopeName();
      project.slopes.push(copy);
      selectedId = copy.id;
      renderAll();
    });
    $('#sDelete').addEventListener('click', function () {
      if (!confirm('Удалить скат «' + slope.name + '»?')) return;
      project.slopes = project.slopes.filter(function (s) { return s.id !== slope.id; });
      selectedId = project.slopes.length ? project.slopes[0].id : null;
      renderAll();
    });
  }

  /* ---------- объекты, импортированные из DWG ---------- */

  function renderObjectProps(obj) {
    const box = $('#slopeProps');
    const canLayout = obj.kind !== 'circle' && obj.kind !== 'text' &&
      Array.isArray(obj.points) && obj.points.length >= 3;
    const hasLayout = (project.slopes || []).some(function (s) { return s.sourceObjectId === obj.id; });

    let html =
      '<div class="prop-row"><label>Тип объекта</label><span class="prop-value">' +
        objectKindLabel(obj.kind) + '</span></div>' +
      '<div class="prop-row"><label>Слой</label><input id="oLayer" type="text" value="' +
        escText(obj.layer || '0') + '"></div>';

    if (obj.kind === 'circle') {
      html +=
        '<div class="prop-row"><label>Центр X, м</label><input id="oCx" type="number" step="0.01" value="' + numericInput(obj.cx) + '"></div>' +
        '<div class="prop-row"><label>Центр Y, м</label><input id="oCy" type="number" step="0.01" value="' + numericInput(obj.cy) + '"></div>' +
        '<div class="prop-row"><label>Радиус, м</label><input id="oR" type="number" step="0.01" min="0.01" value="' + numericInput(obj.r) + '"></div>';
    } else if (obj.kind === 'text') {
      html +=
        '<div class="prop-row"><label>Текст</label><input id="oText" type="text" value="' +
          escText(obj.text || '') + '"></div>' +
        '<div class="prop-row"><label>X, м</label><input id="oX" type="number" step="0.01" value="' + numericInput(obj.x) + '"></div>' +
        '<div class="prop-row"><label>Y, м</label><input id="oY" type="number" step="0.01" value="' + numericInput(obj.y) + '"></div>' +
        '<div class="prop-row"><label>Высота, м</label><input id="oHeight" type="number" step="0.01" min="0.05" value="' + numericInput(obj.height) + '"></div>' +
        '<div class="prop-row"><label>Поворот, °</label><input id="oRotation" type="number" step="1" value="' + numericInput(obj.rotation) + '"></div>';
    } else {
      const bbox = objectPointsBounds(obj.points);
      html +=
        '<div class="prop-row"><label>Точек</label><span class="prop-value">' + (obj.points || []).length +
          (isObjectClosed(obj) ? ' · контур замкнут' : ' · открытая') + '</span></div>' +
        '<div class="prop-row"><label>Габарит</label><span class="prop-value">' +
          (bbox ? KP.fmt(bbox.width) + ' × ' + KP.fmt(bbox.height) + ' м' : '—') + '</span></div>' +
        (hasLayout
          ? '<div class="prop-row"><label>Раскладка</label><span class="prop-value">создана</span></div>'
          : '');
    }

    html += '<div class="prop-actions">' +
      '<button class="btn ghost small" id="oEdit">Редактировать…</button>' +
      (canLayout
        ? '<button class="btn small" id="oToSlope">' +
          (hasLayout ? 'Обновить раскладку' : 'Разложить материал') + '</button>'
        : '') +
      '<button class="btn danger small" id="oDelete">Удалить объект</button>' +
      '</div>';

    box.innerHTML = html;

    $('#oLayer').addEventListener('change', function (ev) {
      obj.layer = ev.target.value.trim() || '0';
      renderAll();
    });

    if (obj.kind === 'circle') {
      [['oCx', 'cx'], ['oCy', 'cy'], ['oR', 'r']].forEach(function (pair) {
        $('#' + pair[0]).addEventListener('change', function (ev) {
          obj[pair[1]] = Math.max(pair[1] === 'r' ? 0.01 : -1e9, KP.num(ev.target.value));
          renderAll();
        });
      });
    } else if (obj.kind === 'text') {
      $('#oText').addEventListener('change', function (ev) {
        obj.text = ev.target.value;
        renderAll();
      });
      [['oX', 'x'], ['oY', 'y'], ['oHeight', 'height'], ['oRotation', 'rotation']].forEach(function (pair) {
        $('#' + pair[0]).addEventListener('change', function (ev) {
          obj[pair[1]] = KP.num(ev.target.value);
          renderAll();
        });
      });
    }

    $('#oEdit').addEventListener('click', function () { openObjectModal(obj); });
    if ($('#oToSlope')) {
      $('#oToSlope').addEventListener('click', function () { objectToSlope(obj); });
    }
    $('#oDelete').addEventListener('click', function () { deleteDrawingObject(obj); });
  }

  function objectPointsBounds(points) {
    if (!points || !points.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    points.forEach(function (p) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    });
    return { width: maxX - minX, height: maxY - minY };
  }

  function deleteDrawingObject(obj) {
    if (!obj) return;
    if (!confirm('Удалить объект «' + objectKindLabel(obj.kind) + '»?')) return;
    project.objects = (project.objects || []).filter(function (item) { return item.id !== obj.id; });
    selectedObjectId = null;
    renderAll();
  }

  function moveDrawingObject(obj, dx, dy) {
    if (!obj || (!dx && !dy)) return;
    if (obj.kind === 'circle') {
      obj.cx = Number((obj.cx + dx).toFixed(3));
      obj.cy = Number((obj.cy + dy).toFixed(3));
    } else if (obj.kind === 'text') {
      obj.x = Number((obj.x + dx).toFixed(3));
      obj.y = Number((obj.y + dy).toFixed(3));
    } else if (Array.isArray(obj.points)) {
      obj.points = obj.points.map(function (p) {
        return { x: Number((p.x + dx).toFixed(3)), y: Number((p.y + dy).toFixed(3)) };
      });
    }
    renderAll();
  }

  function cleanContourPoints(obj) {
    if (!obj || !Array.isArray(obj.points)) return [];
    const points = obj.points.map(function (p) { return { x: KP.num(p.x), y: KP.num(p.y) }; });
    while (points.length > 3) {
      const first = points[0];
      const last = points[points.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) points.pop();
      else break;
    }
    return points;
  }

  function contourEdges(points) {
    const result = [];
    const count = points.length;
    for (let i = 0; i < count; i++) {
      const a = points[i];
      const b = points[(i + 1) % count];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length > 1e-9) result.push({ index: i, a: a, b: b, length: length });
    }
    return result;
  }

  function rotatePointAround(point, center, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
      x: center.x + dx * cos - dy * sin,
      y: center.y + dx * sin + dy * cos
    };
  }

  function edgeTypeLabel(key) {
    return KP.edgeTypeLabels[key] || KP.edgeTypeLabels.rib;
  }

  function layerEdgeType(layer) {
    const value = String(layer || '').toLowerCase().replace(/ё/g, 'е');
    if (value.indexOf('карниз') >= 0) return 'eave';
    if (value.indexOf('конек') >= 0) return 'ridge';
    if (value.indexOf('ендов') >= 0) return 'valley';
    if (value.indexOf('торец') >= 0) return 'end';
    if (value.indexOf('ребр') >= 0) return 'rib';
    return null;
  }

  function pointInPolygon(point, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i];
      const b = points[j];
      const intersects = ((a.y > point.y) !== (b.y > point.y)) &&
        (point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 1e-9) + a.x);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function distanceToLine(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) return Math.hypot(point.x - a.x, point.y - a.y);
    return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / length;
  }

  function typedSourceSegments() {
    const segments = [];
    (project.objects || []).forEach(function (obj) {
      const type = layerEdgeType(obj.layer);
      if (!type || obj.kind === 'circle' || obj.kind === 'text') return;
      const points = Array.isArray(obj.points) ? obj.points : [];
      for (let i = 0; i < points.length - 1; i += 1) {
        segments.push({ a: points[i], b: points[i + 1], type: type });
      }
      if (obj.closed && points.length > 2) {
        segments.push({ a: points[points.length - 1], b: points[0], type: type });
      }
    });
    return segments;
  }

  function assignLayerEdgeTypes(points, edges, raw) {
    const types = new Array(points.length).fill(raw ? null : 'rib');
    const segments = typedSourceSegments();
    if (!segments.length) return raw ? types : types.map(function () { return 'rib'; });
    edges.forEach(function (edge) {
      const dx = edge.b.x - edge.a.x;
      const dy = edge.b.y - edge.a.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-9) return;
      const ux = dx / length;
      const uy = dy / length;
      const tolerance = Math.max(0.03, Math.min(0.2, length * 0.03));
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        const sx = segment.b.x - segment.a.x;
        const sy = segment.b.y - segment.a.y;
        const slen = Math.hypot(sx, sy);
        if (slen < 1e-9) continue;
        if (Math.abs(ux * sx / slen + uy * sy / slen) < 0.995) continue;
        if (Math.min(
          distanceToLine(segment.a, edge.a, edge.b),
          distanceToLine(segment.b, edge.a, edge.b)
        ) > tolerance) continue;
        const mx = (segment.a.x + segment.b.x) / 2;
        const my = (segment.a.y + segment.b.y) / 2;
        const projection = (mx - edge.a.x) * ux + (my - edge.a.y) * uy;
        if (projection < -tolerance || projection > length + tolerance) continue;
        types[edge.index] = segment.type;
        break;
      }
    });
    return raw ? types : types.map(function (type) { return type || 'rib'; });
  }

  function arrowHeadFromObject(obj) {
    if (!obj || (obj.kind !== 'polyline' && obj.kind !== 'line')) return null;
    const raw = (obj.points || []).map(function (p) {
      return { x: KP.num(p.x), y: KP.num(p.y) };
    });
    const points = [];
    raw.forEach(function (point) {
      const last = points[points.length - 1];
      if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 1e-6) points.push(point);
    });
    if (points.length > 2) {
      const first = points[0];
      const last = points[points.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) points.pop();
    }
    if (points.length < 3 || points.length > 8) return null;
    let best = null;
    for (let i = 0; i < points.length; i += 1) {
      if (!obj.closed && (i === 0 || i === points.length - 1)) continue;
      const tip = points[i];
      const prev = points[(i - 1 + points.length) % points.length];
      const next = points[(i + 1) % points.length];
      const v1x = prev.x - tip.x;
      const v1y = prev.y - tip.y;
      const v2x = next.x - tip.x;
      const v2y = next.y - tip.y;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      if (l1 < 0.03 || l2 < 0.03) continue;
      const ratio = Math.min(l1, l2) / Math.max(l1, l2);
      if (ratio < 0.35) continue;
      const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
      const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
      if (angle < 0.12 || angle > 1.75) continue;
      const base = { x: (prev.x + next.x) / 2, y: (prev.y + next.y) / 2 };
      const dx = tip.x - base.x;
      const dy = tip.y - base.y;
      const size = Math.hypot(dx, dy);
      if (size < 0.05) continue;
      const score = ratio / (angle + 0.03);
      if (!best || score > best.score) {
        best = {
          tip: tip,
          base: base,
          direction: { x: dx / size, y: dy / size },
          size: size,
          score: score
        };
      }
    }
    return best;
  }

  function isArrowLayerAllowed(layer) {
    const value = String(layer || '').toLowerCase().replace(/ё/g, 'е');
    return !/(размер|текст|осев|тонк|рамк|defpoints|изображ)/.test(value);
  }

  function arrowForContour(obj, points) {
    const xs = points.map(function (p) { return p.x; });
    const ys = points.map(function (p) { return p.y; });
    const diagonal = Math.hypot(
      Math.max.apply(null, xs) - Math.min.apply(null, xs),
      Math.max.apply(null, ys) - Math.min.apply(null, ys)
    );
    const center = {
      x: xs.reduce(function (sum, value) { return sum + value; }, 0) / points.length,
      y: ys.reduce(function (sum, value) { return sum + value; }, 0) / points.length
    };
    let best = null;
    (project.objects || []).forEach(function (candidate) {
      if (!candidate || candidate.id === obj.id) return;
      if (layerEdgeType(candidate.layer)) return;
      if (!isArrowLayerAllowed(candidate.layer)) return;
      const head = arrowHeadFromObject(candidate);
      if (!head) return;
      if (head.size < diagonal * 0.015 || head.size > diagonal * 0.35) return;
      const middle = {
        x: (head.tip.x + head.base.x) / 2,
        y: (head.tip.y + head.base.y) / 2
      };
      if (!pointInPolygon(middle, points) && !pointInPolygon(head.tip, points)) return;
      const distance = Math.hypot(middle.x - center.x, middle.y - center.y);
      if (!best || head.size > best.head.size + 1e-6 ||
          (Math.abs(head.size - best.head.size) <= 1e-6 && distance < best.distance)) {
        best = { head: head, distance: distance };
      }
    });
    return best ? best.head : null;
  }

  function pickEdgeByDirection(edges, direction, wantMax) {
    const xs = edges.map(function (edge) { return edge.a.x; }).concat(edges.map(function (edge) { return edge.b.x; }));
    const ys = edges.map(function (edge) { return edge.a.y; }).concat(edges.map(function (edge) { return edge.b.y; }));
    const diagonal = Math.hypot(
      Math.max.apply(null, xs) - Math.min.apply(null, xs),
      Math.max.apply(null, ys) - Math.min.apply(null, ys)
    );
    let best = null;
    edges.forEach(function (edge) {
      const length = edge.length || Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y);
      if (length < 1e-9) return;
      const ux = (edge.b.x - edge.a.x) / length;
      const uy = (edge.b.y - edge.a.y) / length;
      const along = Math.abs(ux * direction.x + uy * direction.y);
      const mx = (edge.a.x + edge.b.x) / 2;
      const my = (edge.a.y + edge.b.y) / 2;
      const projection = mx * direction.x + my * direction.y;
      const score = (wantMax ? projection : -projection) - along * diagonal * 0.9;
      if (!best || score > best.score) best = { edge: edge, score: score };
    });
    return best ? best.edge : null;
  }

  function buildEdgeTypes(obj, points, eaveIndex, ridgeIndex, preferred) {
    const count = points.length;
    const edges = contourEdges(points);
    let types = Array.isArray(preferred) && preferred.length === count
      ? preferred.slice()
      : assignLayerEdgeTypes(points, edges);
    types = types.map(function (type) {
      return KP.edgeTypeLabels[type] ? type : 'rib';
    });
    const foundEave = types.indexOf('eave');
    const foundRidge = types.indexOf('ridge');
    const eaveToSet = Number.isInteger(eaveIndex) && eaveIndex >= 0 && eaveIndex < count
      ? eaveIndex : foundEave;
    const ridgeToSet = Number.isInteger(ridgeIndex) && ridgeIndex >= 0 && ridgeIndex < count
      ? ridgeIndex : foundRidge;
    types = types.map(function (type) { return type === 'eave' || type === 'ridge' ? 'rib' : type; });
    if (eaveToSet >= 0 && eaveToSet < count) types[eaveToSet] = 'eave';
    if (ridgeToSet >= 0 && ridgeToSet < count && ridgeToSet !== eaveToSet) {
      types[ridgeToSet] = 'ridge';
    }
    return types;
  }

  function ensureSlopeEdgeTypes(slope) {
    if (!slope || slope.shape !== 'polygon') {
      if (slope) slope.edgeTypes = [];
      return [];
    }
    const points = KP.slopePoints(slope).map(function (p) { return { x: p[0], y: p[1] }; });
    if (points.length < 3) {
      slope.edgeTypes = [];
      return [];
    }
    const preferred = Array.isArray(slope.edgeTypes) && slope.edgeTypes.length === points.length
      ? slope.edgeTypes
      : null;
    slope.edgeTypes = buildEdgeTypes(
      (project.objects || []).find(function (o) { return o.id === slope.sourceObjectId; }),
      points,
      slope.eaveEdge,
      slope.ridgeEdge,
      preferred
    );
    const eaveIndex = slope.edgeTypes.indexOf('eave');
    const ridgeIndex = slope.edgeTypes.indexOf('ridge');
    if (eaveIndex >= 0) slope.eaveEdge = eaveIndex;
    else if (slope.eaveEdge != null) slope.eaveEdge = null;
    if (ridgeIndex >= 0) slope.ridgeEdge = ridgeIndex;
    else if (slope.ridgeEdge != null) slope.ridgeEdge = null;
    return slope.edgeTypes;
  }

  function autoOrientation(obj) {
    const points = cleanContourPoints(obj);
    const edges = contourEdges(points);
    if (!edges.length) return null;
    const arrow = arrowForContour(obj, points);
    if (arrow) {
      const eave = pickEdgeByDirection(edges, arrow.direction, true);
      const ridge = pickEdgeByDirection(edges, arrow.direction, false);
      if (eave && ridge && eave.index !== ridge.index) {
        return {
          eaveEdge: eave.index,
          ridgeEdge: ridge.index,
          startEdge: true
        };
      }
    }
    const layerTypes = assignLayerEdgeTypes(points, edges, true);
    const layerEave = layerTypes.indexOf('eave');
    const layerRidge = layerTypes.indexOf('ridge');
    if (layerEave >= 0 && layerRidge >= 0 && layerEave !== layerRidge) {
      return {
        eaveEdge: layerEave,
        ridgeEdge: layerRidge,
        startEdge: true
      };
    }
    let eave = edges[0];
    edges.forEach(function (edge) { if (edge.length > eave.length) eave = edge; });
    const eaveMid = { x: (eave.a.x + eave.b.x) / 2, y: (eave.a.y + eave.b.y) / 2 };
    let ridge = null;
    let best = -1;
    edges.forEach(function (edge) {
      if (edge.index === eave.index) return;
      const mid = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 };
      const distance = Math.hypot(mid.x - eaveMid.x, mid.y - eaveMid.y);
      if (distance > best) { best = distance; ridge = edge; }
    });
    return {
      eaveEdge: eave.index,
      ridgeEdge: ridge ? ridge.index : eave.index,
      startEdge: true
    };
  }

  function createSlopeFromObject(obj, orientation) {
    const points = cleanContourPoints(obj);
    if (points.length < 3) return null;
    if (orientation && orientation.layoutMode === 'axis') {
      return createAxisSlopeFromObject(obj, orientation);
    }

    const edges = contourEdges(points);
    if (!edges.length) return null;
    const auto = autoOrientation(obj);
    if (!orientation && auto.layoutMode === 'axis') {
      return createAxisSlopeFromObject(obj, auto);
    }
    const eaveIndex = orientation && Number.isInteger(orientation.eaveEdge)
      ? orientation.eaveEdge : auto.eaveEdge;
    let ridgeIndex = orientation && Number.isInteger(orientation.ridgeEdge)
      ? orientation.ridgeEdge : auto.ridgeEdge;
    if (ridgeIndex === eaveIndex) {
      ridgeIndex = auto.ridgeEdge !== eaveIndex
        ? auto.ridgeEdge
        : (eaveIndex + 1) % edges.length;
    }
    const startEdge = !orientation || orientation.startEdge !== false;

    const eave = edges.find(function (edge) { return edge.index === eaveIndex; }) || edges[0];
    const ridge = edges.find(function (edge) { return edge.index === ridgeIndex; }) || edges[0];
    const center = eave.a;

    let angle = Math.atan2(eave.b.y - eave.a.y, eave.b.x - eave.a.x);
    let rotated = points.map(function (p) { return rotatePointAround(p, center, -angle); });
    let eaveA = rotatePointAround(eave.a, center, -angle);
    let eaveB = rotatePointAround(eave.b, center, -angle);
    let ridgeMid = rotatePointAround(
      { x: (ridge.a.x + ridge.b.x) / 2, y: (ridge.a.y + ridge.b.y) / 2 },
      center, -angle
    );
    const eaveMid = rotatePointAround(
      { x: (eave.a.x + eave.b.x) / 2, y: (eave.a.y + eave.b.y) / 2 },
      center, -angle
    );

    // Конёк должен оказаться сверху (в SVG — меньше Y).
    if (ridgeMid.y > eaveMid.y) {
      angle += Math.PI;
      rotated = points.map(function (p) { return rotatePointAround(p, center, -angle); });
      eaveA = rotatePointAround(eave.a, center, -angle);
      eaveB = rotatePointAround(eave.b, center, -angle);
    }

    const xs = rotated.map(function (p) { return p.x; });
    const ys = rotated.map(function (p) { return p.y; });
    const minX = Math.min.apply(null, xs);
    const minY = Math.min.apply(null, ys);
    const maxX = Math.max.apply(null, xs);
    const maxY = Math.max.apply(null, ys);
    const width = maxX - minX;
    const height = maxY - minY;
    if (!(width > 0) || !(height > 0)) return null;

    const local = rotated.map(function (p) {
      return { x: Number((p.x - minX).toFixed(3)), y: Number((p.y - minY).toFixed(3)) };
    });
    if (KP.polygonArea(local) < 0.01) return null;

    const eaveStartsAtLeft = eaveA.x < eaveB.x;
    const layoutStart = startEdge
      ? (eaveStartsAtLeft ? 'left' : 'right')
      : (eaveStartsAtLeft ? 'right' : 'left');

    const existing = (project.slopes || []).find(function (s) { return s.sourceObjectId === obj.id; });
    const slope = existing || KP.newSlope(project, activeMaterialId);
    slope.shape = 'polygon';
    slope.points = local;
    slope.width = Number(width.toFixed(3));
    slope.height = Number(height.toFixed(3));
    slope.topWidth = 0;
    slope.inPlace = true;
    slope.anchor = { x: Number(minX.toFixed(3)), y: Number(minY.toFixed(3)) };
    slope.renderOrigin = { x: Number(center.x.toFixed(3)), y: Number(center.y.toFixed(3)) };
    let rotationDeg = angle * 180 / Math.PI;
    while (rotationDeg > 180) rotationDeg -= 360;
    while (rotationDeg <= -180) rotationDeg += 360;
    slope.rotation = Number(rotationDeg.toFixed(4));
    slope.layoutStart = layoutStart;
    slope.layoutStartEdge = startEdge;
    slope.eaveEdge = eave.index;
    slope.ridgeEdge = ridge.index;
    slope.edgeTypes = buildEdgeTypes(
      obj,
      points,
      eave.index,
      ridge.index,
      orientation && orientation.edgeTypes
    );
    slope.layoutMode = 'edge';
    slope.axisEdge = null;
    slope.axisOrientation = 'vertical';
    slope.layoutMirror = !!(orientation && orientation.layoutMirror);
    slope.sourceObjectId = obj.id;
    if (!existing) {
      slope.name = nextSlopeName();
      project.slopes.push(slope);
    }
    return slope;
  }

  function objectToSlope(obj) {
    if (!obj || !Array.isArray(obj.points) || obj.points.length < 3) {
      alert('Для раскладки нужен контур минимум из 3 точек.');
      return;
    }
    openLayoutOrientationModal(obj);
  }

  function createManualSlopeFromObject(obj, orientation) {
    const points = cleanContourPoints(obj);
    if (points.length < 3) return null;
    const angle = ((KP.num(orientation && orientation.layoutAngle) % 360) + 360) % 360;
    const radians = angle * Math.PI / 180;
    const direction = { x: Math.cos(radians), y: Math.sin(radians) };
    const xs = points.map(function (p) { return p.x; });
    const ys = points.map(function (p) { return p.y; });
    const minSourceX = Math.min.apply(null, xs);
    const maxSourceX = Math.max.apply(null, xs);
    const minSourceY = Math.min.apply(null, ys);
    const maxSourceY = Math.max.apply(null, ys);
    const center = {
      x: (minSourceX + maxSourceX) / 2,
      y: (minSourceY + maxSourceY) / 2
    };
    let rotation = Math.atan2(direction.x, -direction.y);
    const rotated = points.map(function (p) { return rotatePointAround(p, center, -rotation); });
    const xs2 = rotated.map(function (p) { return p.x; });
    const ys2 = rotated.map(function (p) { return p.y; });
    const minX = Math.min.apply(null, xs2);
    const minY = Math.min.apply(null, ys2);
    const maxX = Math.max.apply(null, xs2);
    const maxY = Math.max.apply(null, ys2);
    const width = maxX - minX;
    const height = maxY - minY;
    if (!(width > 0) || !(height > 0)) return null;

    const local = rotated.map(function (p) {
      return { x: Number((p.x - minX).toFixed(3)), y: Number((p.y - minY).toFixed(3)) };
    });
    if (KP.polygonArea(local) < 0.01) return null;

    const existing = (project.slopes || []).find(function (s) { return s.sourceObjectId === obj.id; });
    const slope = existing || KP.newSlope(project, activeMaterialId);
    slope.shape = 'polygon';
    slope.points = local;
    slope.width = Number(width.toFixed(3));
    slope.height = Number(height.toFixed(3));
    slope.topWidth = 0;
    slope.inPlace = true;
    slope.anchor = { x: Number(minX.toFixed(3)), y: Number(minY.toFixed(3)) };
    slope.renderOrigin = { x: Number(center.x.toFixed(3)), y: Number(center.y.toFixed(3)) };
    let rotationDeg = rotation * 180 / Math.PI;
    while (rotationDeg > 180) rotationDeg -= 360;
    while (rotationDeg <= -180) rotationDeg += 360;
    slope.rotation = Number(rotationDeg.toFixed(4));
    slope.layoutMode = 'manual';
    slope.layoutAngle = Number(angle.toFixed(2));
    slope.layoutStart = 'left';
    slope.layoutStartEdge = true;
    slope.layoutMirror = !!(orientation && orientation.layoutMirror);
    slope.eaveEdge = null;
    slope.ridgeEdge = null;
    slope.axisEdge = null;
    slope.edgeTypes = buildEdgeTypes(
      obj,
      points,
      null,
      null,
      orientation && orientation.edgeTypes
    );
    slope.sourceObjectId = obj.id;
    if (!existing) {
      slope.name = nextSlopeName();
      project.slopes.push(slope);
    }
    return slope;
  }

  function createAxisSlopeFromObject(obj, orientation) {
    const points = cleanContourPoints(obj);
    if (points.length < 3) return null;
    const edges = contourEdges(points);
    if (!edges.length) return null;

    const axisIndex = orientation && Number.isInteger(orientation.axisEdge)
      ? orientation.axisEdge
      : (orientation && Number.isInteger(orientation.eaveEdge) ? orientation.eaveEdge : 0);
    const axis = edges.find(function (edge) { return edge.index === axisIndex; }) || edges[0];
    const axisOrientation = orientation && orientation.axisOrientation === 'horizontal'
      ? 'horizontal' : 'vertical';
    const mirror = !!(orientation && orientation.layoutMirror);
    const startEdge = !orientation || orientation.startEdge !== false;
    const center = { x: (axis.a.x + axis.b.x) / 2, y: (axis.a.y + axis.b.y) / 2 };
    const baseAngle = Math.atan2(axis.b.y - axis.a.y, axis.b.x - axis.a.x);
    let angle = baseAngle + (axisOrientation === 'horizontal' ? Math.PI / 2 : 0);
    let rotated = points.map(function (p) { return rotatePointAround(p, center, -angle); });
    let axisA = rotatePointAround(axis.a, center, -angle);
    let axisB = rotatePointAround(axis.b, center, -angle);

    const minMaxY = function () {
      const values = rotated.map(function (p) { return p.y; });
      return { min: Math.min.apply(null, values), max: Math.max.apply(null, values) };
    };
    let boundsY = minMaxY();
    if (axisA.y - boundsY.min < boundsY.max - axisA.y) {
      angle += Math.PI;
      rotated = points.map(function (p) { return rotatePointAround(p, center, -angle); });
      axisA = rotatePointAround(axis.a, center, -angle);
      axisB = rotatePointAround(axis.b, center, -angle);
      boundsY = minMaxY();
    }

    const xs = rotated.map(function (p) { return p.x; });
    const ys = rotated.map(function (p) { return p.y; });
    const minX = Math.min.apply(null, xs);
    const minY = Math.min.apply(null, ys);
    const maxX = Math.max.apply(null, xs);
    const maxY = Math.max.apply(null, ys);
    const width = maxX - minX;
    const height = maxY - minY;
    if (!(width > 0) || !(height > 0)) return null;

    const local = rotated.map(function (p) {
      return { x: Number((p.x - minX).toFixed(3)), y: Number((p.y - minY).toFixed(3)) };
    });
    if (KP.polygonArea(local) < 0.01) return null;

    const axisStartsAtLeft = axisA.x < axisB.x;
    const layoutStart = startEdge
      ? (axisStartsAtLeft ? 'left' : 'right')
      : (axisStartsAtLeft ? 'right' : 'left');

    const existing = (project.slopes || []).find(function (s) { return s.sourceObjectId === obj.id; });
    const slope = existing || KP.newSlope(project, activeMaterialId);
    slope.shape = 'polygon';
    slope.points = local;
    slope.width = Number(width.toFixed(3));
    slope.height = Number(height.toFixed(3));
    slope.topWidth = 0;
    slope.inPlace = true;
    slope.anchor = { x: Number(minX.toFixed(3)), y: Number(minY.toFixed(3)) };
    slope.renderOrigin = { x: Number(center.x.toFixed(3)), y: Number(center.y.toFixed(3)) };
    let rotationDeg = angle * 180 / Math.PI;
    while (rotationDeg > 180) rotationDeg -= 360;
    while (rotationDeg <= -180) rotationDeg += 360;
    slope.rotation = Number(rotationDeg.toFixed(4));
    slope.layoutStart = layoutStart;
    slope.layoutStartEdge = startEdge;
    slope.layoutMode = 'axis';
    slope.axisEdge = axis.index;
    slope.axisOrientation = axisOrientation;
    slope.layoutMirror = mirror;
    slope.eaveEdge = null;
    slope.ridgeEdge = null;
    slope.edgeTypes = buildEdgeTypes(
      obj,
      points,
      null,
      null,
      orientation && orientation.edgeTypes
    );
    slope.sourceObjectId = obj.id;
    if (!existing) {
      slope.name = nextSlopeName();
      project.slopes.push(slope);
    }
    return slope;
  }

  function openLayoutOrientationModal(obj) {
    if (!obj) return;
    const points = cleanContourPoints(obj);
    const edges = contourEdges(points);
    if (edges.length < 3) {
      alert('Для выбора стороны нужно минимум 3 ребра контура.');
      return;
    }
    const existing = (project.slopes || []).find(function (s) { return s.sourceObjectId === obj.id; });
    const defaults = autoOrientation(obj);
    const savedTypes = existing && Array.isArray(existing.edgeTypes) && existing.edgeTypes.length === points.length
      ? existing.edgeTypes.slice()
      : null;

    let eaveIndex = existing && Number.isInteger(existing.eaveEdge) ? existing.eaveEdge : defaults.eaveEdge;
    let ridgeIndex = existing && Number.isInteger(existing.ridgeEdge) ? existing.ridgeEdge : defaults.ridgeEdge;
    if (!Number.isInteger(eaveIndex) || !edges.some(function (edge) { return edge.index === eaveIndex; })) {
      eaveIndex = edges[0].index;
    }
    if (!Number.isInteger(ridgeIndex) || !edges.some(function (edge) { return edge.index === ridgeIndex; }) ||
        ridgeIndex === eaveIndex) {
      const eaveEdge = edges.find(function (edge) { return edge.index === eaveIndex; }) || edges[0];
      const eaveMid = { x: (eaveEdge.a.x + eaveEdge.b.x) / 2, y: (eaveEdge.a.y + eaveEdge.b.y) / 2 };
      let farthest = null;
      let farthestDistance = -1;
      edges.forEach(function (edge) {
        if (edge.index === eaveIndex) return;
        const mid = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 };
        const distance = Math.hypot(mid.x - eaveMid.x, mid.y - eaveMid.y);
        if (distance > farthestDistance) {
          farthestDistance = distance;
          farthest = edge;
        }
      });
      ridgeIndex = farthest ? farthest.index : ((eaveIndex + 1) % edges.length);
    }
    const startEdge = existing && existing.layoutStartEdge === false ? false : true;
    const manualMode = !!(existing && existing.layoutMode === 'manual');
    const manualAngle = manualMode && Number.isFinite(Number(existing.layoutAngle))
      ? Number(existing.layoutAngle)
      : 90;
    const manualMirror = !!(existing && existing.layoutMirror);

    const edgeOptions = function (selected) {
      return edges.map(function (edge) {
        return '<option value="' + edge.index + '"' + (edge.index === selected ? ' selected' : '') + '>' +
          'Контур ' + (edge.index + 1) + ' · ' + KP.fmt(edge.length) + ' м</option>';
      }).join('');
    };

    const body =
      '<div class="layout-orient">' +
        '<div class="layout-orient-preview" id="layoutOrientPreview"></div>' +
        '<div class="layout-orient-fields">' +
          '<div class="field"><label>Старт раскладки</label><select id="layoutStartMode">' +
            '<option value="edge"' + (!manualMode ? ' selected' : '') + '>От карниза</option>' +
            '<option value="manual"' + (manualMode ? ' selected' : '') + '>Вручную</option>' +
          '</select></div>' +
          '<div class="field" id="layoutEaveField"><label>Карниз (нижняя кромка)</label><select id="layoutEave">' +
            edgeOptions(eaveIndex) + '</select></div>' +
          '<div class="field" id="layoutRidgeField"><label>Конёк (верхняя кромка)</label><select id="layoutRidge">' +
            edgeOptions(ridgeIndex) + '</select></div>' +
          '<div id="layoutManualFields">' +
            '<div class="field"><label>Угол раскладки, °</label><input id="layoutManualAngle" type="number" step="1" min="0" max="360" value="' +
              Number(manualAngle.toFixed(1)) + '"></div>' +
            '<label class="check-row"><input id="layoutManualMirror" type="checkbox"' +
              (manualMirror ? ' checked' : '') + '> Зеркально</label>' +
          '</div>' +
          '<p class="shape-hint" id="layoutHint">' +
            (manualMode
              ? 'Листы идут от линии старта под заданным углом. 0° — вправо, 90° — вниз. Направление можно указать на чертеже в свойствах ската.'
              : 'Листы идут от карниза. Первый лист начинается от начала ребра карниза.') +
          '</p>' +
        '</div>' +
      '</div>';

    function paintPreview() {
      const box = document.getElementById('layoutOrientPreview');
      if (!box) return;
      const modeSelect = document.getElementById('layoutStartMode');
      const manual = !!(modeSelect && modeSelect.value === 'manual');
      const eave = parseInt(document.getElementById('layoutEave').value, 10);
      const ridge = parseInt(document.getElementById('layoutRidge').value, 10);
      const xs = points.map(function (p) { return p.x; });
      const ys = points.map(function (p) { return p.y; });
      const minX = Math.min.apply(null, xs);
      const minY = Math.min.apply(null, ys);
      const maxX = Math.max.apply(null, xs);
      const maxY = Math.max.apply(null, ys);
      const w = Math.max(0.001, maxX - minX);
      const h = Math.max(0.001, maxY - minY);
      const pad = Math.max(0.4, Math.max(w, h) * 0.12);
      const font = Math.max(0.1, Math.max(w, h) * 0.035);
      const pointsAttr = points.map(function (p) { return p.x + ',' + p.y; }).join(' ');

      let svg = '<svg viewBox="' + (minX - pad) + ' ' + (minY - pad) + ' ' + (w + pad * 2) + ' ' +
        (h + pad * 2) + '" preserveAspectRatio="xMidYMid meet" class="layout-orient-svg">';
      svg += '<rect x="' + (minX - pad) + '" y="' + (minY - pad) + '" width="' + (w + pad * 2) +
        '" height="' + (h + pad * 2) + '" fill="#ffffff"/>';
      svg += '<polygon points="' + pointsAttr + '" fill="#f4f4f4" stroke="#b8b8b8" ' +
        'stroke-width="1" vector-effect="non-scaling-stroke"/>';

      if (!manual) {
        edges.forEach(function (edge) {
          const isEave = edge.index === eave;
          const isRidge = edge.index === ridge;
          const stroke = isEave ? '#d7202a' : (isRidge ? '#2f6f9f' : '#8a8a8a');
          const width = isEave || isRidge ? 3.5 : 1;
          svg += '<line x1="' + edge.a.x + '" y1="' + edge.a.y + '" x2="' + edge.b.x + '" y2="' + edge.b.y +
            '" stroke="' + stroke + '" stroke-width="' + width + '" vector-effect="non-scaling-stroke"/>';
          const mx = (edge.a.x + edge.b.x) / 2;
          const my = (edge.a.y + edge.b.y) / 2;
          svg += '<text x="' + (mx + font * 0.3) + '" y="' + (my - font * 0.3) + '" font-size="' + font +
            '" fill="' + stroke + '" font-weight="' + (isEave || isRidge ? '700' : '400') +
            '" font-family="Geologica, Segoe UI, Arial, sans-serif">' + (edge.index + 1) + '</text>';
          if (isEave) {
            svg += '<text x="' + mx + '" y="' + (my + font * 1.6) + '" text-anchor="middle" font-size="' + (font * 1.1) +
              '" fill="#d7202a" font-weight="700" font-family="Geologica, Segoe UI, Arial, sans-serif">карниз</text>';
          }
          if (isRidge) {
            svg += '<text x="' + mx + '" y="' + (my - font * 1.1) + '" text-anchor="middle" font-size="' + (font * 1.1) +
              '" fill="#2f6f9f" font-weight="700" font-family="Geologica, Segoe UI, Arial, sans-serif">конёк</text>';
          }
        });
      } else {
        const angleInput = document.getElementById('layoutManualAngle');
        const deg = angleInput ? KP.num(angleInput.value) : 90;
        const rad = (Number.isFinite(deg) ? deg : 90) * Math.PI / 180;
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const len = Math.max(w, h) * 0.36;
        const dx = Math.cos(rad);
        const dy = Math.sin(rad);
        const px = -dy;
        const py = dx;
        const tip = { x: cx + dx * len, y: cy + dy * len };
        const back = { x: cx + dx * len * 0.78, y: cy + dy * len * 0.78 };
        const head = Math.max(len * 0.12, Math.max(w, h) * 0.03);
        svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + back.x + '" y2="' + back.y +
          '" stroke="#d7202a" stroke-width="2.5" vector-effect="non-scaling-stroke"/>';
        svg += '<polygon points="' + tip.x + ',' + tip.y + ' ' +
          (back.x + px * head) + ',' + (back.y + py * head) + ' ' +
          (back.x - px * head) + ',' + (back.y - py * head) + '" fill="#d7202a"/>';
        svg += '<text x="' + (tip.x + dx * font * 0.4) + '" y="' + (tip.y + dy * font * 1.2) +
          '" text-anchor="middle" font-size="' + (font * 1.1) +
          '" fill="#d7202a" font-weight="700" font-family="Geologica, Segoe UI, Arial, sans-serif">листы</text>';
      }

      svg += '</svg>';
      box.innerHTML = svg;
    }

    openModal(existing ? 'Ориентация раскладки' : 'Раскладка материала', body, function () {
      const mode = document.getElementById('layoutStartMode').value;
      let slope = null;
      if (mode === 'manual') {
        const angle = KP.num(document.getElementById('layoutManualAngle').value);
        slope = createManualSlopeFromObject(obj, {
          layoutAngle: Number.isFinite(angle) ? angle : 90,
          layoutMirror: !!document.getElementById('layoutManualMirror').checked,
          edgeTypes: savedTypes
        });
      } else {
        const eave = parseInt(document.getElementById('layoutEave').value, 10);
        const ridge = parseInt(document.getElementById('layoutRidge').value, 10);
        if (eave === ridge) {
          alert('Карниз и конёк должны быть разными рёбрами контура.');
          return false;
        }
        slope = createSlopeFromObject(obj, {
          eaveEdge: eave,
          ridgeEdge: ridge,
          startEdge: startEdge,
          layoutMirror: existing ? !!existing.layoutMirror : false,
          edgeTypes: savedTypes
        });
      }
      if (!slope) {
        alert('Не удалось построить раскладку: проверьте контур.');
        return false;
      }
      selectedId = slope.id;
      selectedObjectId = null;
      renderAll();
      return true;
    }, { saveLabel: existing ? 'Обновить раскладку' : 'Создать раскладку', wide: true });

    const modeSelect = document.getElementById('layoutStartMode');
    const eaveField = document.getElementById('layoutEaveField');
    const ridgeField = document.getElementById('layoutRidgeField');
    const manualFields = document.getElementById('layoutManualFields');
    const hint = document.getElementById('layoutHint');
    const angleInput = document.getElementById('layoutManualAngle');
    const mirrorInput = document.getElementById('layoutManualMirror');

    function syncMode() {
      const manual = modeSelect.value === 'manual';
      eaveField.classList.toggle('hidden', manual);
      ridgeField.classList.toggle('hidden', manual);
      manualFields.classList.toggle('hidden', !manual);
      if (hint) {
        hint.textContent = manual
          ? 'Листы идут от линии старта под заданным углом. 0° — вправо, 90° — вниз. Направление можно указать на чертеже в свойствах ската.'
          : 'Листы идут от карниза. Первый лист начинается от начала ребра карниза.';
      }
      paintPreview();
    }

    const eaveSelect = document.getElementById('layoutEave');
    const ridgeSelect = document.getElementById('layoutRidge');
    eaveSelect.addEventListener('change', paintPreview);
    ridgeSelect.addEventListener('change', paintPreview);
    modeSelect.addEventListener('change', syncMode);
    if (angleInput) angleInput.addEventListener('input', paintPreview);
    if (mirrorInput) mirrorInput.addEventListener('change', paintPreview);
    syncMode();
  }

  function layoutDwgContours(silent) {
    const allPolygons = (project.objects || []).filter(function (obj) {
      return Array.isArray(obj.points) && obj.points.length >= 3;
    });
    let objects = allPolygons.filter(isObjectClosed);

    if (!objects.length) {
      if (!allPolygons.length) {
        alert('Полигональные контуры DWG не найдены.\n' +
          'Выберите нужный объект на холсте или в списке и нажмите «Разложить материал».');
        return;
      }
      if (!confirm('Замкнутые контуры не найдены.\n' +
        'Разложить материал по всем полилиниям с 3 и более точками (' + allPolygons.length + ' шт.)?')) {
        return;
      }
      objects = allPolygons;
    } else if (!silent) {
      if (!confirm('Создать раскладку материала для ' + objects.length + ' замкнутых контуров DWG?\n' +
        'Ориентация будет выбрана автоматически — затем её можно изменить в свойствах ската.')) return;
    }

    let created = 0;
    let updated = 0;
    let failed = 0;
    let last = null;
    objects.forEach(function (obj) {
      const existed = (project.slopes || []).some(function (s) { return s.sourceObjectId === obj.id; });
      const slope = createSlopeFromObject(obj, autoOrientation(obj));
      if (!slope) { failed++; return; }
      if (existed) updated++; else created++;
      last = slope;
    });
    if (last) {
      selectedId = last.id;
      selectedObjectId = null;
    }
    renderAll();
    if (canvasApi) canvasApi.fitView();
    alert('Раскладка материала:\nсоздано — ' + created + ', обновлено — ' + updated +
      (failed ? ', пропущено — ' + failed : '') + '.');
  }

  function openObjectModal(obj) {
    if (!obj) return;
    const isContour = obj.kind !== 'circle' && obj.kind !== 'text';
    let body = '<p class="shape-hint">Объект: <b>' + objectKindLabel(obj.kind) + '</b>. ' +
      'Слой: ' + escText(obj.layer || '0') + '.</p>';

    if (isContour) {
      body +=
        '<div class="field"><label>Точки контура — «X;Y» по одной на строку</label>' +
          '<textarea id="objPoints" spellcheck="false" style="width:100%;min-height:220px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-family:Consolas,monospace;font-size:12.5px;line-height:1.5">' +
          (obj.points || []).map(function (p) { return p.x + ';' + p.y; }).join('\n') + '</textarea></div>' +
        '<label class="check-row"><input id="objClosed" type="checkbox"' + (obj.closed ? ' checked' : '') + '> Замкнутый контур</label>';
    } else if (obj.kind === 'circle') {
      body +=
        '<div class="form-grid">' +
          '<div class="field"><label>Центр X, м</label><input id="objCx" type="number" step="0.01" value="' + numericInput(obj.cx) + '"></div>' +
          '<div class="field"><label>Центр Y, м</label><input id="objCy" type="number" step="0.01" value="' + numericInput(obj.cy) + '"></div>' +
          '<div class="field"><label>Радиус, м</label><input id="objR" type="number" step="0.01" min="0.01" value="' + numericInput(obj.r) + '"></div>' +
        '</div>';
    } else {
      body +=
        '<div class="field"><label>Текст</label><input id="objText" type="text" value="' + escText(obj.text || '') + '"></div>' +
        '<div class="form-grid">' +
          '<div class="field"><label>X, м</label><input id="objX" type="number" step="0.01" value="' + numericInput(obj.x) + '"></div>' +
          '<div class="field"><label>Y, м</label><input id="objY" type="number" step="0.01" value="' + numericInput(obj.y) + '"></div>' +
          '<div class="field"><label>Высота, м</label><input id="objHeight" type="number" step="0.01" min="0.05" value="' + numericInput(obj.height) + '"></div>' +
          '<div class="field"><label>Поворот, °</label><input id="objRotation" type="number" step="1" value="' + numericInput(obj.rotation) + '"></div>' +
        '</div>';
    }

    openModal('Редактирование объекта', body, function () {
      if (isContour) {
        const pts = parsePointList(document.getElementById('objPoints').value, 2);
        if (!pts || pts.length < 2) {
          alert('Введите минимум 2 точки в формате X;Y.');
          return false;
        }
        obj.points = pts.map(function (p) {
          return { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)) };
        });
        obj.closed = document.getElementById('objClosed').checked;
      } else if (obj.kind === 'circle') {
        obj.cx = KP.num(document.getElementById('objCx').value);
        obj.cy = KP.num(document.getElementById('objCy').value);
        obj.r = Math.max(0.01, KP.num(document.getElementById('objR').value));
      } else {
        obj.text = document.getElementById('objText').value;
        obj.x = KP.num(document.getElementById('objX').value);
        obj.y = KP.num(document.getElementById('objY').value);
        obj.height = Math.max(0.05, KP.num(document.getElementById('objHeight').value));
        obj.rotation = KP.num(document.getElementById('objRotation').value);
      }
      renderAll();
      return true;
    }, { saveLabel: 'Применить' });
  }

  /* ---------- статистика ---------- */

  function renderStats(calc) {
    const table = $('#slopeStats');
    const row = calc.rows.find(function (r) { return r.slope.id === selectedId; });
    if (!row) {
      table.innerHTML = '<tbody><tr><td>Нет данных</td><td>—</td></tr></tbody>';
      return;
    }
    table.innerHTML = '<thead><tr><th>Показатель</th><th>Значение</th></tr></thead><tbody>' +
      KP.statsRows(row).map(function (r) {
        return '<tr><td>' + r.label + '</td><td class="' + (r.warn ? 'warn' : '') + '">' + r.value + '</td></tr>';
      }).join('') + '</tbody>';
  }

  function renderLengths(calc) {
    const table = $('#lengthList');
    const row = calc.rows.find(function (r) { return r.slope.id === selectedId; });
    if (!row || !row.list.length) {
      table.innerHTML = '<tbody><tr><td>Нет листов</td><td>—</td><td>—</td></tr></tbody>';
      return;
    }
    table.innerHTML = '<thead><tr><th>Длина, м</th><th>Кол-во</th><th>Полная, м²</th></tr></thead><tbody>' +
      row.list.map(function (item) {
        return '<tr><td>' + KP.fmt(item.length, 3) + '</td><td>' + item.count + '</td><td>' +
          KP.fmt(item.length * row.fullWidth * item.count) + '</td></tr>';
      }).join('') +
      '<tr class="total-row"><td>Итого</td><td>' + row.sheetCount + '</td><td>' +
      KP.fmt(row.fullArea) + '</td></tr></tbody>';
  }

  /* ---------- доборные элементы ---------- */

  function renderElements(calc) {
    const table = $('#elementsTable');
    if (!project.elements.length) {
      table.innerHTML = '<tbody><tr><td>Доборные элементы не добавлены</td><td></td><td></td><td></td><td></td></tr></tbody>';
      return;
    }
    table.innerHTML = '<thead><tr><th>Наименование</th><th>Ед.</th><th>Кол-во</th><th>Цена, ₽</th><th>Сумма, ₽</th><th></th></tr></thead><tbody>' +
      project.elements.map(function (el) {
        return '<tr data-el="' + el.id + '">' +
          '<td class="name-cell">' + el.name + '</td>' +
          '<td>' + (el.unit || 'м') + '</td>' +
          '<td><input type="number" step="0.1" min="0" value="' + numericInput(el.qty) + '" data-qty="1"></td>' +
          '<td><input type="number" step="1" min="0" value="' + numericInput(el.price) + '" data-price="1"></td>' +
          '<td>' + KP.fmt(KP.num(el.qty) * KP.num(el.price), 0) + '</td>' +
          '<td><button class="icon-btn" data-del="1" title="Удалить">×</button></td>' +
        '</tr>';
      }).join('') +
      '<tr class="total-row"><td>Итого</td><td></td><td></td><td></td><td>' +
      KP.fmt(calc.totals.elementCost, 0) + '</td><td></td></tr></tbody>';

    table.querySelectorAll('tr[data-el]').forEach(function (tr) {
      const el = project.elements.find(function (e) { return e.id === tr.getAttribute('data-el'); });
      const qty = tr.querySelector('[data-qty]');
      const price = tr.querySelector('[data-price]');
      if (qty) qty.addEventListener('change', function () { el.qty = KP.num(qty.value); renderAll(); });
      if (price) price.addEventListener('change', function () { el.price = KP.num(price.value); renderAll(); });
      const del = tr.querySelector('[data-del]');
      if (del) del.addEventListener('click', function () {
        project.elements = project.elements.filter(function (e) { return e.id !== el.id; });
        renderAll();
      });
    });
  }

  function renderSummary(calc) {
    const table = $('#summaryTable');
    if (!calc.usage.length) {
      table.innerHTML = '<tbody><tr><td>Нет данных по материалам</td></tr></tbody>';
      return;
    }
    table.innerHTML = '<thead><tr><th>Материал</th><th>Скатов</th><th>Листов, шт</th>' +
      '<th>Полная площадь, м²</th><th>Полезная площадь, м²</th><th>Стоимость, ₽</th></tr></thead><tbody>' +
      calc.usage.map(function (u) {
        return '<tr><td class="name-cell">' + u.material.name + '</td><td>' + u.slopes + '</td><td>' +
          u.sheets + '</td><td>' + KP.fmt(u.fullArea) + '</td><td>' + KP.fmt(u.usefulArea) +
          '</td><td>' + KP.fmt(u.cost, 0) + '</td></tr>';
      }).join('') +
      '<tr class="total-row"><td>Итого</td><td></td><td>' + calc.totals.sheets + '</td><td>' +
      KP.fmt(calc.totals.fullArea) + '</td><td>' + KP.fmt(calc.totals.usefulArea) + '</td><td>' +
      KP.fmt(calc.totals.materialCost, 0) + '</td></tr></tbody>';
  }

  function renderSpecification(calc) {
    const box = $('#specification');
    if (!box) return;
    const usage = calc.usage || [];
    const rows = calc.rows || [];
    const materials = usage.map(function (u) { return u.material; });
    const firstMaterial = materials[0] || {};
    const fmt = function (value, digits) {
      return KP.fmt(value, typeof digits === 'number' ? digits : 2);
    };
    const allSameNumber = function (key) {
      return materials.every(function (m) {
        return Math.abs(KP.num(m[key]) - KP.num(firstMaterial[key])) < 1e-9;
      });
    };
    const calcTypes = Array.from(new Set(materials.map(function (m) {
      return m.calcType || (KP.TYPES[m.type] && KP.TYPES[m.type].label) || '';
    }).filter(Boolean)));
    const widthText = materials.length && allSameNumber('usefulWidth') && allSameNumber('fullWidth')
      ? fmt(firstMaterial.usefulWidth, 3) + ' / ' + fmt(firstMaterial.fullWidth, 3)
      : 'по материалам';
    const overlapText = materials.length && allSameNumber('lockOverlap')
      ? fmt(KP.num(firstMaterial.lockOverlap) / 1000, 2)
      : 'по материалам';
    const roundingText = materials.length && allSameNumber('roundingMm')
      ? fmt(KP.num(firstMaterial.roundingMm) / 1000, 2)
      : 'по материалам';
    const eaveOverhangText = materials.length && allSameNumber('eaveOverhang')
      ? fmt(KP.num(firstMaterial.eaveOverhang) / 1000, 2)
      : 'по материалам';
    const waveStepText = materials.length && allSameNumber('waveStep')
      ? fmt(KP.num(firstMaterial.waveStep) * 1000, 0) + ' мм'
      : 'по материалам';

    let html = '<h3 class="spec-title">Параметры расчёта</h3>' +
      '<table class="data-table spec-kv"><tbody>' +
        '<tr><th>Расчёт №</th><td>' + escText(project.number || project.id || '—') +
          ' от ' + escText(project.date || KP.today()) + '</td>' +
          '<th>Вид расчёта</th><td>' + escText(calcTypes.length ? calcTypes.join('; ') : '—') + '</td></tr>' +
        '<tr><th>Площадка</th><td>' + escText(project.name || '—') + '</td>' +
          '<th>Заказчик</th><td>' + escText(project.customer || '—') + '</td></tr>' +
        '<tr><th>Продукция</th><td colspan="3">' +
          escText(materials.length ? materials.map(function (m) { return m.name; }).join('; ') : '—') + '</td></tr>' +
        '<tr><th>Ширина листа полезная / общая, м</th><td>' + widthText + '</td>' +
          '<th>Перекрытие замковое, м</th><td>' + overlapText + '</td></tr>' +
        '<tr><th>Округление, м</th><td>' + roundingText + '</td>' +
          '<th>Карнизный свес, м</th><td>' + eaveOverhangText + '</td></tr>' +
        '<tr><th>Шаг волны, мм</th><td colspan="3">' + waveStepText + '</td></tr>' +
        '<tr><th>Листов, шт</th><td colspan="3">' + calc.totals.sheets + '</td></tr>' +
      '</tbody></table>';

    if (!rows.length) {
      html += '<p class="panel-note">Нет скатов для формирования спецификации.</p>';
    } else {
      html += '<h3 class="spec-title">Параметры скатов</h3>' +
        '<table class="data-table wide spec-table"><thead><tr>' +
          '<th>№</th><th>H ската, м</th><th>S ската, м²</th><th>S фигуры, м²</th>' +
          '<th>S полная листов, м²</th><th>S полезн. листов, м²</th><th>% отходов</th>' +
        '</tr></thead><tbody>' +
          rows.map(function (row, index) {
            return '<tr><td>' + (index + 1) + '</td><td>' + fmt(row.slope.height) +
              '</td><td>' + fmt(row.slopeArea) + '</td><td>' + fmt(row.figureArea) +
              '</td><td>' + fmt(row.fullArea) + '</td><td>' + fmt(row.usefulArea) +
              '</td><td>' + fmt(row.waste) + '</td></tr>';
          }).join('') +
          '<tr class="total-row"><td>Итог</td><td>' +
            fmt(rows.reduce(function (sum, row) { return sum + KP.num(row.slope.height); }, 0)) +
            '</td><td>' + fmt(calc.totals.area) + '</td><td>' + fmt(calc.totals.area) +
            '</td><td>' + fmt(calc.totals.fullArea) + '</td><td>' + fmt(calc.totals.usefulArea) +
            '</td><td>' + fmt(calc.totals.waste) + '</td></tr></tbody></table>';

      const lengthMap = new Map();
      rows.forEach(function (row) {
        row.list.forEach(function (item) {
          const key = Number(item.length).toFixed(3);
          if (!lengthMap.has(key)) lengthMap.set(key, { length: Number(item.length), count: 0 });
          lengthMap.get(key).count += item.count;
        });
      });
      const lengthRows = Array.from(lengthMap.values()).sort(function (a, b) {
        return a.length - b.length;
      });
      if (lengthRows.length) {
        html += '<h3 class="spec-title">Список длин</h3>' +
          '<table class="data-table spec-lengths"><thead><tr><th>№</th><th>Длина, м</th>' +
          '<th>Кол-во, шт</th></tr></thead><tbody>' +
          lengthRows.map(function (item, index) {
            return '<tr><td>' + (index + 1) + '</td><td>' + fmt(item.length, 3) +
              '</td><td>' + item.count + '</td></tr>';
          }).join('') +
          '<tr class="total-row"><td>Итого</td><td></td><td>' + calc.totals.sheets +
          '</td></tr></tbody></table>';
      }
    }

    if (!usage.length) {
      html += '<p class="panel-note">Нет данных по материалам.</p>';
    } else {
      html += '<h3 class="spec-title">Материалы для заказа</h3>' +
        '<table class="data-table wide spec-table"><thead><tr>' +
          '<th>№</th><th>Материал</th><th>Площадь кровли, м²</th><th>Площадь листов, м²</th>' +
          '<th>Полезная площадь, м²</th><th>Листов, шт</th><th>Сумма, ₽</th></tr></thead><tbody>' +
          usage.map(function (u, index) {
            const details = [
              u.material.nomenclatureCode ? 'Номер расчёта ' + u.material.nomenclatureCode : '',
              u.material.coating,
              u.material.color
            ].filter(Boolean).join(' · ');
            return '<tr><td>' + (index + 1) + '</td>' +
              '<td class="name-cell"><div>' + escText(u.material.name) + '</div>' +
                (details ? '<div class="mat-meta">' + escText(details) + '</div>' : '') + '</td>' +
              '<td>' + fmt(u.roofArea) + '</td>' +
              '<td>' + fmt(u.fullArea) + '</td>' +
              '<td>' + fmt(u.usefulArea) + '</td>' +
              '<td>' + u.sheets + '</td>' +
              '<td>' + fmt(u.cost, 0) + '</td></tr>';
          }).join('') +
          '<tr class="total-row"><td>Итого</td><td></td><td>' + fmt(calc.totals.area) +
            '</td><td>' + fmt(calc.totals.fullArea) + '</td><td>' + fmt(calc.totals.usefulArea) +
            '</td><td>' + calc.totals.sheets + '</td><td>' + fmt(calc.totals.materialCost, 0) +
          '</td></tr></tbody></table>';
    }

    const elements = project.elements.map(function (el) {
      return {
        name: el.name,
        unit: el.unit || 'м',
        qty: KP.num(el.qty),
        price: KP.num(el.price),
        calculated: false
      };
    });
    const screwRows = elements.filter(function (el) { return /саморез/i.test(el.name); });
    let screwsQty = screwRows.reduce(function (sum, el) { return sum + el.qty; }, 0);
    if (!screwRows.length && calc.totals.fullArea > 0) {
      const qty = Math.ceil(calc.totals.fullArea * 8);
      elements.push({
        name: 'Саморезы кровельные (8 шт/м²)',
        unit: 'шт',
        qty: qty,
        price: 8,
        calculated: true
      });
      screwsQty = qty;
    }
    const elementCost = elements.reduce(function (sum, el) {
      return sum + el.qty * el.price;
    }, 0);

    html += '<h3 class="spec-title">Доборные элементы и крепёж</h3>';
    if (!elements.length) {
      html += '<p class="panel-note">Доборные элементы не добавлены.</p>';
    } else {
      html += '<table class="data-table wide spec-table"><thead><tr>' +
        '<th>№</th><th>Наименование</th><th>Ед.</th><th>Кол-во</th><th>Цена, ₽</th><th>Сумма, ₽</th>' +
        '</tr></thead><tbody>' +
        elements.map(function (el, index) {
          return '<tr' + (el.calculated ? ' class="spec-calc-row"' : '') + '><td>' + (index + 1) +
            '</td><td class="name-cell">' + escText(el.name) + '</td><td>' + escText(el.unit) +
            '</td><td>' + KP.fmt(el.qty, el.unit === 'шт' ? 0 : 2) + '</td><td>' +
            KP.fmt(el.price, 0) + '</td><td>' + KP.fmt(el.qty * el.price, 0) + '</td></tr>';
        }).join('') +
        '<tr class="total-row"><td>Итого</td><td></td><td></td><td></td><td></td><td>' +
        KP.fmt(elementCost, 0) + '</td></tr></tbody></table>';
    }

    html += '<div class="spec-summary">' +
      '<div><span>Площадь кровли</span><b>' + fmt(calc.totals.area) + ' м²</b></div>' +
      '<div><span>Площадь листов</span><b>' + fmt(calc.totals.fullArea) + ' м²</b></div>' +
      '<div><span>Полезная площадь</span><b>' + fmt(calc.totals.usefulArea) + ' м²</b></div>' +
      '<div><span>Листов</span><b>' + calc.totals.sheets + ' шт</b></div>' +
      '<div><span>Саморезов</span><b>' + KP.fmt(screwsQty, 0) + ' шт</b></div>' +
      '<div><span>Материалы</span><b>' + KP.fmt(calc.totals.materialCost, 0) + ' ₽</b></div>' +
      '<div><span>Доборы и крепёж</span><b>' + KP.fmt(elementCost, 0) + ' ₽</b></div>' +
      '<div class="accent"><span>ИТОГО</span><b>' +
        KP.fmt(calc.totals.materialCost + elementCost, 0) + ' ₽</b></div>' +
    '</div>' +
    '<p class="panel-note">Спецификация сформирована по текущей раскладке. Норма саморезов — 8 шт/м²; при наличии позиции «Саморезы» используется указанное количество.</p>';
    box.innerHTML = html;
  }

  function renderLayoutPages(calc) {
    const box = $('#layoutPages');
    if (!box) return;
    const svg = canvasApi ? canvasApi.getSvg() : null;
    if (!svg || !project.slopes.length || !KP.buildLayoutPages) {
      box.innerHTML = '<p class="panel-note">Добавьте скаты, чтобы построить раскладку листов.</p>';
      return;
    }
    box.innerHTML = KP.buildLayoutPages(svg, calc || KP.calcProject(project), project);
  }

  function renderTotals(calc) {
    const t = calc.totals;
    const cards = [
      { label: 'Площадь скатов, м²', value: KP.fmt(t.area) },
      { label: 'Полная площадь листов, м²', value: KP.fmt(t.fullArea) },
      { label: 'Полезная площадь листов, м²', value: KP.fmt(t.usefulArea) },
      { label: 'Отходы, %', value: KP.fmt(t.waste) },
      { label: 'Листов, шт', value: String(t.sheets) },
      { label: 'Материалы, ₽', value: KP.fmt(t.materialCost, 0) },
      { label: 'Доборные элементы, ₽', value: KP.fmt(t.elementCost, 0) },
      { label: 'ИТОГО, ₽', value: KP.fmt(t.total, 0), accent: true }
    ];
    $('#totalsGrid').innerHTML = cards.map(function (c) {
      return '<div class="total-card ' + (c.accent ? 'accent' : '') + '">' +
        '<div class="label">' + c.label + '</div><div class="value">' + c.value + '</div></div>';
    }).join('');
  }

  /* ---------- вставка фигуры по координатам и размерам ---------- */

  function parsePointList(text, minPoints) {
    const matches = String(text || '').match(/-?\d+(?:[.,]\d+)?/g);
    if (!matches) return null;
    const values = matches.map(KP.num);
    const minimum = Math.max(1, minPoints || 1);
    if (values.length < minimum * 2 || values.length % 2 !== 0) return null;
    const points = [];
    for (let i = 0; i < values.length; i += 2) {
      points.push({ x: values[i], y: values[i + 1] });
    }
    return points;
  }

  function parseCoordPoints(text) {
    return parsePointList(text, 3);
  }

  function coordsForKind(kind, width, height, topWidth, slant) {
    const w = Math.max(0.1, width);
    const h = Math.max(0.1, height);
    if (kind === 'triangle') return [[w / 2, 0], [w, h], [0, h]];
    if (kind === 'trapezoid') {
      const tw = Math.max(0, Math.min(topWidth, w));
      return [[(w - tw) / 2, 0], [(w + tw) / 2, 0], [w, h], [0, h]];
    }
    if (kind === 'parallelogram') {
      const s = slant || 0;
      return [[s, 0], [s + w, 0], [w, h], [0, h]];
    }
    return [[0, 0], [w, 0], [w, h], [0, h]];
  }

  function shapeLibraryItem(key) {
    return (KP.shapeLibrary || []).find(function (item) { return item.key === key; }) || null;
  }

  function scaleLibraryPoints(item, width, height) {
    if (!item) return [];
    const w = Math.max(0.1, width);
    const h = Math.max(0.1, height);
    return item.points.map(function (p) {
      return [w * p[0] / item.width, h * p[1] / item.height];
    });
  }

  function shapeLibraryMarkup() {
    return (KP.shapeLibrary || []).map(function (item) {
      const points = item.points.map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
      const viewHeight = Math.max(1, item.height);
      return '<button type="button" class="shape-lib-tile" data-lib-shape="' + item.key +
        '" title="' + escText(item.name) + '">' +
        '<svg viewBox="-0.5 -0.5 11 ' + (viewHeight + 1) + '" preserveAspectRatio="xMidYMid meet">' +
          '<polygon points="' + points + '" fill="#fafafa" stroke="#272727" stroke-width="0.8" ' +
            'vector-effect="non-scaling-stroke" stroke-linejoin="round"/>' +
        '</svg>' +
        '<span>' + escText(item.name.replace('Форма ', '')) + '</span>' +
      '</button>';
    }).join('');
  }

  function formatCoords(points) {
    return points.map(function (p) {
      return Number(p[0].toFixed(3)) + ';' + Number(p[1].toFixed(3));
    }).join('\n');
  }

  // Пользовательские координаты: (0;0) — левый нижний угол, X — вправо,
  // Y — вверх. Внутри проекта Y направлена вниз (экранная система SVG),
  // поэтому на вводе и выводе координаты переворачиваются.
  function pointsHeight(points) {
    const ys = (points || []).map(function (p) { return KP.num(p[1]); });
    if (!ys.length) return 0;
    return Math.max.apply(null, ys) - Math.min.apply(null, ys);
  }

  function pointsToUser(points, height) {
    const h = Number.isFinite(Number(height)) ? Number(height) : pointsHeight(points);
    return (points || []).map(function (p) {
      return [KP.num(p[0]), Number((h - KP.num(p[1])).toFixed(3))];
    });
  }

  function pointsFromUser(points) {
    const list = (points || []).map(function (p) { return [KP.num(p[0]), KP.num(p[1])]; });
    const ys = list.map(function (p) { return p[1]; });
    const maxY = ys.length ? Math.max.apply(null, ys) : 0;
    return list.map(function (p) { return [p[0], Number((maxY - p[1]).toFixed(3))]; });
  }

  function openShapeModal(existingSlope, startMode, preferredKind) {
    const isEdit = !!existingSlope;
    const base = existingSlope || KP.newSlope(project, activeMaterialId);
    const startPoints = isEdit
      ? KP.slopePoints(existingSlope)
      : [[0, 0], [10, 0], [10, 5], [0, 5]];
    const materialId = base.materialId || (project.materials[0] && project.materials[0].id) || '';
    const width = KP.num(base.width) || 10;
    const height = KP.num(base.height) || 5;
    const kind = existingSlope && ['rect', 'trapezoid', 'triangle'].indexOf(existingSlope.shape) >= 0
      ? existingSlope.shape
      : (preferredKind || 'rect');
    const initialMode = startMode === 'dims' ? 'dims' : 'coords';

    const body =
      '<div class="modal-tabs">' +
        '<button type="button" class="' + (initialMode === 'coords' ? 'active' : '') + '" data-mode="coords">По координатам</button>' +
        '<button type="button" class="' + (initialMode === 'dims' ? 'active' : '') + '" data-mode="dims">По размерам</button>' +
      '</div>' +
      '<div class="form-grid">' +
        '<div class="field"><label>Название фигуры</label><input id="shapeName" type="text" value="' +
          escText(isEdit ? (base.name || 'Скат') : nextSlopeName()) + '"></div>' +
        '<div class="field"><label>Материал</label><select id="shapeMaterial">' +
          materialOptionList(materialId) + '</select></div>' +
      '</div>' +
      '<div class="shape-pane' + (initialMode === 'coords' ? '' : ' hidden') + '" data-pane="coords">' +
        '<p class="shape-hint">Вершины контура в метрах: «X;Y» по одной на строку или списком. ' +
        'X — вправо, Y — вверх, (0;0) — левый нижний угол контура. ' +
        'Контур замыкается автоматически, координаты нормализуются к нулю.</p>' +
        '<textarea id="shapeCoords" spellcheck="false">' + formatCoords(pointsToUser(startPoints)) + '</textarea>' +
        '<div class="shape-preview" id="shapePreview"></div>' +
      '</div>' +
      '<div class="shape-pane' + (initialMode === 'dims' ? '' : ' hidden') + '" data-pane="dims">' +
        '<p class="shape-hint">Фигура строится по индивидуальным размерам.</p>' +
        '<div class="form-grid">' +
          '<div class="field"><label>Шаблон фигуры</label><select id="shapeKind">' +
            '<option value="rect"' + (kind === 'rect' ? ' selected' : '') + '>Прямоугольник</option>' +
            '<option value="trapezoid"' + (kind === 'trapezoid' ? ' selected' : '') + '>Трапеция</option>' +
            '<option value="triangle"' + (kind === 'triangle' ? ' selected' : '') + '>Треугольник</option>' +
            '<option value="parallelogram">Параллелограмм</option>' +
            '<option value="library">Форма из библиотеки</option>' +
          '</select></div>' +
          '<div class="field"><label>Ширина, м</label><input id="shapeWidth" type="number" step="0.01" min="0.1" value="' +
            Number(width.toFixed(2)) + '"></div>' +
          '<div class="field"><label>Длина / высота, м</label><input id="shapeHeight" type="number" step="0.01" min="0.1" value="' +
            Number(height.toFixed(2)) + '"></div>' +
          '<div class="field ' + (kind === 'trapezoid' ? '' : 'hidden') + '" id="shapeTopField">' +
            '<label>Верхняя ширина, м</label><input id="shapeTop" type="number" step="0.01" min="0" value="' +
            Number((KP.num(base.topWidth) || width * 0.6).toFixed(2)) + '"></div>' +
          '<div class="field hidden" id="shapeSlantField">' +
            '<label>Смещение верха, м</label><input id="shapeSlant" type="number" step="0.01" value="0"></div>' +
        '</div>' +
        '<div class="shape-library-head">' +
          '<span>Формы скатов</span>' +
          '<span class="panel-note">выберите форму, затем задайте размеры</span>' +
        '</div>' +
        '<div class="shape-library" id="shapeLibrary">' + shapeLibraryMarkup() + '</div>' +
      '</div>';

    let mode = initialMode;
    let dimsTouched = false;
    let selectedLibraryKey = null;

    function currentLibraryItem() {
      return shapeLibraryItem(selectedLibraryKey);
    }

    function markLibraryTiles() {
      modalRoot.querySelectorAll('[data-lib-shape]').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-lib-shape') === selectedLibraryKey);
      });
    }

    function applyLibraryShape(key) {
      const item = shapeLibraryItem(key);
      if (!item) return;
      selectedLibraryKey = key;
      const widthValue = Math.max(0.1, KP.num($('#shapeWidth').value) || 10);
      const heightValue = Number((widthValue * item.height / item.width).toFixed(2));
      $('#shapeWidth').value = widthValue;
      $('#shapeHeight').value = heightValue;
      $('#shapeKind').value = 'library';
      $('#shapeCoords').value = formatCoords(pointsToUser(scaleLibraryPoints(item, widthValue, heightValue)));
      dimsTouched = true;
      markLibraryTiles();
      updateKindFields();
      preview();
    }

    function preview() {
      const box = $('#shapePreview');
      if (!box) return;
      const pts = parseCoordPoints($('#shapeCoords').value);
      if (!pts) {
        box.textContent = 'Нужно минимум 3 вершины (6 чисел).';
        return;
      }
      const norm = KP.normalizePoints(pts);
      const area = KP.polygonArea(norm.points);
      box.textContent = 'Вершин: ' + pts.length + ' · площадь: ' + KP.fmt(area) +
        ' м² · габарит: ' + KP.fmt(norm.width) + ' × ' + KP.fmt(norm.height) + ' м';
    }

    function syncDimsFromCoords() {
      const pts = parseCoordPoints($('#shapeCoords').value);
      if (!pts) return;
      const norm = KP.normalizePoints(pts);
      $('#shapeWidth').value = Number(norm.width.toFixed(2));
      $('#shapeHeight').value = Number(norm.height.toFixed(2));
    }

    function syncCoordsFromDims() {
      const kindValue = $('#shapeKind').value;
      if (kindValue === 'library') {
        const item = currentLibraryItem();
        if (!item) return;
        const w = Math.max(0.1, KP.num($('#shapeWidth').value) || item.width);
        const h = Math.max(0.1, KP.num($('#shapeHeight').value) || item.height);
        $('#shapeCoords').value = formatCoords(pointsToUser(scaleLibraryPoints(item, w, h)));
        preview();
        return;
      }
      const pts = coordsForKind(
        kindValue,
        KP.num($('#shapeWidth').value),
        KP.num($('#shapeHeight').value),
        KP.num($('#shapeTop').value),
        KP.num($('#shapeSlant').value)
      );
      $('#shapeCoords').value = formatCoords(pointsToUser(pts));
      preview();
    }

    function updateKindFields() {
      const kindValue = $('#shapeKind').value;
      $('#shapeTopField').classList.toggle('hidden', kindValue !== 'trapezoid');
      $('#shapeSlantField').classList.toggle('hidden', kindValue !== 'parallelogram');
    }

    openModal(isEdit ? 'Фигура: координаты и размеры' : 'Новая фигура', body, function () {
      const name = $('#shapeName').value.trim() || 'Новая фигура';
      const material = $('#shapeMaterial').value;
      let slope = existingSlope;

      if (mode === 'coords') {
        const userPoints = parseCoordPoints($('#shapeCoords').value);
        const pts = userPoints ? pointsFromUser(userPoints) : null;
        if (!pts) {
          alert('Введите минимум 3 вершины в формате X;Y.');
          return false;
        }
        const norm = KP.normalizePoints(pts);
        if (!(norm.width > 0) || !(norm.height > 0) || KP.polygonArea(norm.points) <= 0) {
          alert('Не удалось построить фигуру: проверьте координаты вершин.');
          return false;
        }
        if (!slope) slope = KP.newSlope(project, material);
        slope.shape = 'polygon';
        slope.points = norm.points;
        slope.width = norm.width;
        slope.height = norm.height;
        slope.topWidth = 0;
      } else {
        const kindValue = $('#shapeKind').value;
        const w = KP.num($('#shapeWidth').value);
        const h = KP.num($('#shapeHeight').value);
        const tw = KP.num($('#shapeTop').value);
        if (w <= 0 || h <= 0) {
          alert('Ширина и высота должны быть больше нуля.');
          return false;
        }
        const libraryItem = kindValue === 'library' ? currentLibraryItem() : null;
        if (kindValue === 'library' && !libraryItem) {
          alert('Выберите форму из библиотеки.');
          return false;
        }
        if (!slope) slope = KP.newSlope(project, material);
        if (libraryItem) {
          const pts = scaleLibraryPoints(libraryItem, w, h).map(function (p) {
            return { x: p[0], y: p[1] };
          });
          const norm = KP.normalizePoints(pts);
          slope.shape = 'polygon';
          slope.points = norm.points;
          slope.width = norm.width;
          slope.height = norm.height;
          slope.topWidth = 0;
        } else if (kindValue === 'parallelogram') {
          const pts = coordsForKind('parallelogram', w, h, tw, KP.num($('#shapeSlant').value))
            .map(function (p) { return { x: p[0], y: p[1] }; });
          const norm = KP.normalizePoints(pts);
          slope.shape = 'polygon';
          slope.points = norm.points;
          slope.width = norm.width;
          slope.height = norm.height;
          slope.topWidth = 0;
        } else {
          slope.shape = kindValue;
          slope.points = [];
          slope.width = w;
          slope.height = h;
          slope.topWidth = kindValue === 'trapezoid' ? Math.max(0, Math.min(tw, w)) : 0;
        }
      }

      slope.name = name;
      slope.materialId = material;
      if (existingSlope) slope.sheetLengthDeltas = [];
      if (!existingSlope) {
        placeSlopeClearOfOthers(slope);
        project.slopes.push(slope);
      }
      selectedId = slope.id;
      renderAll();
      return true;
    }, { wide: true });

    modalRoot.querySelectorAll('.modal-tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        mode = btn.getAttribute('data-mode');
        modalRoot.querySelectorAll('.modal-tabs button').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        modalRoot.querySelectorAll('.shape-pane').forEach(function (pane) {
          pane.classList.toggle('hidden', pane.getAttribute('data-pane') !== mode);
        });
        if (mode === 'dims') {
          syncDimsFromCoords();
          updateKindFields();
        } else if (dimsTouched) {
          syncCoordsFromDims();
        }
      });
    });

    ['shapeWidth', 'shapeHeight', 'shapeTop', 'shapeSlant'].forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', function () {
        dimsTouched = true;
        if (mode === 'dims') syncCoordsFromDims();
      });
    });
    modalRoot.querySelectorAll('[data-lib-shape]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyLibraryShape(btn.getAttribute('data-lib-shape'));
      });
    });
    $('#shapeKind').addEventListener('change', function () {
      dimsTouched = true;
      if ($('#shapeKind').value === 'library') {
        if (!currentLibraryItem() && KP.shapeLibrary && KP.shapeLibrary.length) {
          applyLibraryShape(KP.shapeLibrary[0].key);
          return;
        }
      } else {
        selectedLibraryKey = null;
        markLibraryTiles();
      }
      updateKindFields();
      syncCoordsFromDims();
    });
    $('#shapeCoords').addEventListener('input', function () {
      if (selectedLibraryKey) {
        selectedLibraryKey = null;
        markLibraryTiles();
        if ($('#shapeKind').value === 'library') $('#shapeKind').value = 'rect';
        updateKindFields();
      }
      preview();
    });
    updateKindFields();
    preview();
  }

  /* ---------- вырезы внутри ската ---------- */

  // Перевод точки из координат чертежа в локальные координаты ската
  // (обратное преобразование к тому, что делает canvas при повороте).
  function worldToSlopeLocal(slope, point) {
    const origin = slope.renderOrigin || { x: 0, y: 0 };
    const angle = (KP.num(slope.rotation) || 0) * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = KP.num(point.x) - KP.num(origin.x);
    const dy = KP.num(point.y) - KP.num(origin.y);
    const anchor = slope.anchor || { x: 0, y: 0 };
    return {
      x: Number((dx * cos + dy * sin - KP.num(anchor.x)).toFixed(3)),
      y: Number((-dx * sin + dy * cos - KP.num(anchor.y)).toFixed(3))
    };
  }

  function objectContourPoints(obj) {
    if (!obj) return [];
    if (obj.kind === 'circle') {
      const cx = KP.num(obj.cx);
      const cy = KP.num(obj.cy);
      const r = KP.num(obj.r);
      const points = [];
      for (let i = 0; i < 32; i += 1) {
        const a = i / 32 * Math.PI * 2;
        points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      return points;
    }
    return cleanContourPoints(obj);
  }

  function openCutoutModal(existingSlope) {
    const slope = existingSlope || selectedSlope();
    if (!slope) {
      alert('Сначала выберите скат, в котором нужно сделать вырез.');
      return;
    }

    const width = Math.max(0.1, KP.num(slope.width));
    const height = Math.max(0.1, KP.num(slope.height));
    const defW = Math.max(0.2, Number((width * 0.4).toFixed(2)));
    const defH = Math.max(0.2, Number((height * 0.4).toFixed(2)));
    const defX = Number(((width - defW) / 2).toFixed(2));
    const defY = Number(((height - defH) / 2).toFixed(2));
    const existingList = Array.isArray(slope.cutouts) ? slope.cutouts : [];
    // Координаты выреза задаются от нижнего левого угла ската:
    // X — вправо, Y — вверх. Внутри проекта ось Y растёт вниз,
    // поэтому при вводе переворачиваем её относительно нижней кромки.
    const contourBounds = function () {
      const pts = KP.slopePoints(slope);
      let left = Infinity;
      let bottom = -Infinity;
      pts.forEach(function (p) {
        const px = KP.num(p[0]);
        const py = KP.num(p[1]);
        if (px < left) left = px;
        if (py > bottom) bottom = py;
      });
      return {
        left: Number.isFinite(left) ? left : 0,
        bottom: Number.isFinite(bottom) ? bottom : 0
      };
    };
    const userToLocal = function (points) {
      const bounds = contourBounds();
      return (points || []).map(function (p) {
        return { x: bounds.left + KP.num(p.x), y: bounds.bottom - KP.num(p.y) };
      });
    };
    const objects = (project.objects || []).filter(function (obj) {
      return obj.kind === 'circle' || (Array.isArray(obj.points) && obj.points.length >= 3);
    });
    const dwgAvailable = !!(slope.inPlace && slope.renderOrigin) && objects.length > 0;
    const defaultRect = [
      [defX, defY],
      [defX + defW, defY],
      [defX + defW, defY + defH],
      [defX, defY + defH]
    ];

    function cutoutListHtml() {
      const list = Array.isArray(slope.cutouts) ? slope.cutouts : [];
      if (!list.length) return '<p class="panel-note">Вырезов пока нет.</p>';
      return '<div class="cutout-list">' + list.map(function (cut, index) {
        return '<div class="cutout-item"><span>' + escText(cut.name || ('Вырез ' + (index + 1))) +
          ' · ' + KP.fmt(KP.polygonArea(cut.points || [])) + ' м²</span>' +
          '<button type="button" class="btn ghost small" data-cut-delete="' + escText(cut.id) + '">Удалить</button></div>';
      }).join('') + '</div>';
    }

    const body =
      '<div class="modal-tabs">' +
        '<button type="button" class="active" data-cut-mode="coords">По координатам</button>' +
        '<button type="button" data-cut-mode="template">По шаблону</button>' +
        '<button type="button" data-cut-mode="dwg">Из DWG</button>' +
      '</div>' +
      '<div class="form-grid">' +
        '<div class="field"><label>Название выреза</label><input id="cutName" type="text" value="Вырез ' +
          (existingList.length + 1) + '"></div>' +
      '</div>' +
      '<div class="shape-pane" data-cut-pane="coords">' +
        '<p class="shape-hint">Вершины в метрах относительно левого нижнего угла ската (0;0 — нижний левый угол контура, ось Y — вверх). ' +
          'Контур замыкается автоматически.</p>' +
        '<textarea id="cutCoords" spellcheck="false">' + escText(formatCoords(defaultRect)) + '</textarea>' +
      '</div>' +
      '<div class="shape-pane hidden" data-cut-pane="template">' +
        '<div class="form-grid">' +
          '<div class="field"><label>Тип выреза</label><select id="cutKind">' +
            '<option value="rect">Прямоугольник</option>' +
            '<option value="trapezoid">Трапеция</option>' +
            '<option value="triangle">Треугольник</option>' +
            '<option value="circle">Круг / эллипс</option>' +
            '<option value="library">Форма из библиотеки</option>' +
          '</select></div>' +
          '<div class="field"><label>Ширина, м</label><input id="cutWidth" type="number" step="0.01" min="0.1" value="' + defW + '"></div>' +
          '<div class="field"><label>Высота, м</label><input id="cutHeight" type="number" step="0.01" min="0.1" value="' + defH + '"></div>' +
          '<div class="field"><label>Смещение X, м</label><input id="cutOffsetX" type="number" step="0.01" value="' + defX + '"></div>' +
          '<div class="field"><label>Смещение Y от низа, м</label><input id="cutOffsetY" type="number" step="0.01" value="' + defY + '"></div>' +
          '<div class="field hidden" id="cutTopField"><label>Верхняя ширина, м</label><input id="cutTop" type="number" step="0.01" min="0" value="' +
            Number((defW * 0.6).toFixed(2)) + '"></div>' +
        '</div>' +
        '<div id="cutLibraryWrap" class="hidden">' +
          '<div class="shape-library-head"><span>Формы для выреза</span>' +
            '<span class="panel-note">выберите форму, затем задайте размеры</span></div>' +
          '<div class="shape-library" id="cutLibrary">' + shapeLibraryMarkup() + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="shape-pane hidden" data-cut-pane="dwg">' +
        (dwgAvailable
          ? '<p class="shape-hint">Контур объекта чертежа/DWG переводится в координаты выбранного ската.</p>' +
            '<div class="form-grid"><div class="field"><label>Контур объекта</label><select id="cutObject">' +
              objects.map(function (obj, index) {
                const info = obj.kind === 'circle'
                  ? 'круг R ' + KP.fmt(obj.r)
                  : (obj.points.length + ' точек');
                return '<option value="' + escText(obj.id) + '">' +
                  escText((index + 1) + '. ' + (obj.layer || '0') + ' · ' + info) + '</option>';
              }).join('') + '</select></div></div>'
          : '<p class="shape-hint">Доступно для скатов, вставленных в чертёж из DWG. ' +
            'Для обычного ската используйте координаты или шаблон.</p>') +
      '</div>' +
      '<div class="shape-preview" id="cutPreview"></div>' +
      '<div class="cutout-existing"><div class="prop-section-title">Вырезы на скате</div>' +
        cutoutListHtml() + '</div>';

    let mode = 'coords';
    let selectedLibraryKey = null;

    function templatePoints() {
      if (!$('#cutKind')) return null;
      const kind = $('#cutKind').value;
      const cutW = KP.num($('#cutWidth').value);
      const cutH = KP.num($('#cutHeight').value);
      const offsetX = KP.num($('#cutOffsetX').value);
      const offsetY = KP.num($('#cutOffsetY').value);
      if (!(cutW > 0) || !(cutH > 0)) return null;
      let points;
      if (kind === 'circle') {
        points = [];
        for (let i = 0; i < 32; i += 1) {
          const a = i / 32 * Math.PI * 2;
          points.push({
            x: cutW / 2 + cutW / 2 * Math.cos(a),
            y: cutH / 2 + cutH / 2 * Math.sin(a)
          });
        }
      } else if (kind === 'library') {
        const item = shapeLibraryItem(selectedLibraryKey);
        if (!item) return null;
        points = scaleLibraryPoints(item, cutW, cutH).map(function (p) {
          return { x: p[0], y: p[1] };
        });
      } else {
        points = coordsForKind(kind, cutW, cutH, KP.num($('#cutTop').value), 0).map(function (p) {
          return { x: p[0], y: p[1] };
        });
      }
      // Пользовательские координаты: (0;0) — левый нижний угол ската,
      // ось Y вверх, поэтому фигуру отражаем по вертикали.
      return points.map(function (p) {
        return { x: p.x + offsetX, y: offsetY + (cutH - p.y) };
      });
    }

    function dwgPoints() {
      const select = $('#cutObject');
      if (!select || !select.value) return null;
      const object = (project.objects || []).find(function (obj) { return obj.id === select.value; });
      if (!object) return null;
      return objectContourPoints(object).map(function (p) {
        return worldToSlopeLocal(slope, p);
      });
    }

    function collectPoints() {
      if (mode === 'template') return userToLocal(templatePoints());
      if (mode === 'dwg') return dwgPoints();
      const textarea = $('#cutCoords');
      const parsed = textarea ? parseCoordPoints(textarea.value) : null;
      return parsed ? userToLocal(parsed) : parsed;
    }

    function slopeContourLocal() {
      return KP.slopePoints(slope).map(function (p) { return { x: p[0], y: p[1] }; });
    }

    function insideSlope(points) {
      const contour = slopeContourLocal();
      return points.every(function (p) {
        if (pointInPolygon(p, contour)) return true;
        for (let i = 0; i < contour.length; i += 1) {
          const a = contour[i];
          const b = contour[(i + 1) % contour.length];
          if (distanceToLine(p, a, b) < 0.02) return true;
        }
        return false;
      });
    }

    function updatePreview() {
      const box = $('#cutPreview');
      if (!box) return;
      const points = collectPoints();
      if (!points || points.length < 3) {
        box.textContent = 'Нужно минимум 3 вершины.';
        return;
      }
      const xs = points.map(function (p) { return p.x; });
      const ys = points.map(function (p) { return p.y; });
      const bw = Math.max.apply(null, xs) - Math.min.apply(null, xs);
      const bh = Math.max.apply(null, ys) - Math.min.apply(null, ys);
      box.textContent = 'Вершин: ' + points.length +
        ' · площадь: ' + KP.fmt(KP.polygonArea(points)) + ' м²' +
        ' · габарит: ' + KP.fmt(bw) + ' × ' + KP.fmt(bh) + ' м' +
        (insideSlope(points) ? ' · внутри ската' : ' · ВНИМАНИЕ: выходит за контур ската');
    }

    openModal('Добавить вырез — ' + slope.name, body, function () {
      const points = collectPoints();
      if (!points || points.length < 3) {
        alert('Введите минимум 3 вершины выреза.');
        return false;
      }
      if (KP.polygonArea(points) < 0.01) {
        alert('Площадь выреза слишком мала.');
        return false;
      }
      if (!insideSlope(points)) {
        alert('Вырез должен полностью находиться внутри контура ската.');
        return false;
      }
      const nameField = $('#cutName');
      const name = (nameField && nameField.value.trim()) ||
        ('Вырез ' + ((slope.cutouts || []).length + 1));
      slope.cutouts = Array.isArray(slope.cutouts) ? slope.cutouts : [];
      slope.cutouts.push({
        id: KP.uid('cut'),
        name: name,
        points: points.map(function (p) {
          return { x: Number(KP.num(p.x).toFixed(3)), y: Number(KP.num(p.y).toFixed(3)) };
        })
      });
      renderAll();
      return true;
    }, { wide: true, saveLabel: 'Добавить вырез' });

    modalRoot.querySelectorAll('[data-cut-mode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        mode = btn.getAttribute('data-cut-mode');
        modalRoot.querySelectorAll('[data-cut-mode]').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        modalRoot.querySelectorAll('[data-cut-pane]').forEach(function (pane) {
          pane.classList.toggle('hidden', pane.getAttribute('data-cut-pane') !== mode);
        });
        updatePreview();
      });
    });

    function markCutLibraryTiles() {
      modalRoot.querySelectorAll('[data-lib-shape]').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-lib-shape') === selectedLibraryKey);
      });
    }

    const kindSelect = $('#cutKind');
    if (kindSelect) {
      kindSelect.addEventListener('change', function () {
        const isLibrary = kindSelect.value === 'library';
        const topField = $('#cutTopField');
        if (topField) topField.classList.toggle('hidden', kindSelect.value !== 'trapezoid');
        const libraryWrap = $('#cutLibraryWrap');
        if (libraryWrap) libraryWrap.classList.toggle('hidden', !isLibrary);
        if (isLibrary && !selectedLibraryKey && KP.shapeLibrary && KP.shapeLibrary.length) {
          selectedLibraryKey = KP.shapeLibrary[0].key;
          markCutLibraryTiles();
        }
        updatePreview();
      });
    }

    modalRoot.querySelectorAll('[data-lib-shape]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectedLibraryKey = btn.getAttribute('data-lib-shape');
        if (kindSelect) kindSelect.value = 'library';
        const libraryWrap = $('#cutLibraryWrap');
        if (libraryWrap) libraryWrap.classList.remove('hidden');
        markCutLibraryTiles();
        updatePreview();
      });
    });

    ['cutCoords', 'cutWidth', 'cutHeight', 'cutOffsetX', 'cutOffsetY', 'cutTop'].forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', updatePreview);
    });
    const objectSelect = $('#cutObject');
    if (objectSelect) {
      if (selectedObjectId && objects.some(function (obj) { return obj.id === selectedObjectId; })) {
        objectSelect.value = selectedObjectId;
      }
      objectSelect.addEventListener('change', updatePreview);
    }

    modalRoot.querySelectorAll('[data-cut-delete]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = btn.getAttribute('data-cut-delete');
        slope.cutouts = (slope.cutouts || []).filter(function (cut) { return cut.id !== id; });
        renderAll();
        openCutoutModal(slope);
      });
    });

    updatePreview();
  }

  /* ---------- скат по отрезкам ---------- */

  function openSegmentsModal() {
    const rows = [
      { length: 10, angle: 0 },
      { length: 5, angle: 90 },
      { length: 10, angle: 180 },
      { length: 5, angle: 270 }
    ];

    const body =
      '<div class="form-grid">' +
        '<div class="field"><label>Начало X, м</label><input id="segStartX" type="number" step="0.01" value="0"></div>' +
        '<div class="field"><label>Начало Y, м</label><input id="segStartY" type="number" step="0.01" value="0"></div>' +
      '</div>' +
      '<p class="shape-hint">Каждая строка — отрезок: длина и угол. 0° — вправо, 90° — вверх, 180° — влево, -90° — вниз. Контур замыкается автоматически.</p>' +
      '<table class="segments-table">' +
        '<thead><tr><th>№</th><th>Длина, м</th><th>Угол, °</th><th>ΔX, м</th><th>ΔY, м</th><th></th></tr></thead>' +
        '<tbody id="segRows"></tbody>' +
      '</table>' +
      '<div class="segments-actions">' +
        '<button type="button" class="btn ghost small" id="segAdd">+ Отрезок</button>' +
        '<button type="button" class="btn ghost small" id="segReset">Сбросить</button>' +
      '</div>' +
      '<div class="shape-preview" id="segPreview"></div>';

    function readRows() {
      const result = [];
      const tbody = document.getElementById('segRows');
      if (!tbody) return result;
      tbody.querySelectorAll('tr[data-row]').forEach(function (tr) {
        result.push({
          length: KP.num(tr.querySelector('[data-len]').value),
          angle: KP.num(tr.querySelector('[data-ang]').value)
        });
      });
      return result;
    }

    function syncRows() {
      const current = readRows();
      rows.length = 0;
      current.forEach(function (r) { rows.push(r); });
    }

    function computePoints() {
      const startX = KP.num(document.getElementById('segStartX').value);
      const startY = KP.num(document.getElementById('segStartY').value);
      const list = readRows();
      const points = [{ x: startX, y: startY }];
      let x = startX;
      let y = startY;
      list.forEach(function (r) {
        const rad = r.angle * Math.PI / 180;
        x += r.length * Math.cos(rad);
        y -= r.length * Math.sin(rad);
        points.push({ x: x, y: y });
      });
      return { points: points, rows: list };
    }

    function updatePreview() {
      const data = computePoints();
      const pts = data.points;
      const preview = document.getElementById('segPreview');
      if (!preview) return;

      let perimeter = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        perimeter += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      }
      const closure = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
      const norm = KP.normalizePoints(pts);
      const area = KP.polygonArea(norm.points);

      preview.textContent = 'Отрезков: ' + data.rows.length + ' · Вершин: ' + pts.length +
        ' · Площадь: ' + KP.fmt(area) + ' м² · Периметр: ' + KP.fmt(perimeter) +
        ' м · Замыкание: ' + KP.fmt(closure) + ' м';

      const tbody = document.getElementById('segRows');
      tbody.querySelectorAll('tr[data-row]').forEach(function (tr, index) {
        const r = data.rows[index];
        if (!r) return;
        const rad = r.angle * Math.PI / 180;
        tr.querySelector('.seg-dx').textContent = KP.fmt(r.length * Math.cos(rad));
        tr.querySelector('.seg-dy').textContent = KP.fmt(-r.length * Math.sin(rad));
      });
    }

    function renderRows() {
      const tbody = document.getElementById('segRows');
      if (!tbody) return;
      tbody.innerHTML = rows.map(function (r, index) {
        return '<tr data-row="' + index + '">' +
          '<td>' + (index + 1) + '</td>' +
          '<td><input type="number" step="0.01" min="0" data-len value="' + r.length + '"></td>' +
          '<td><input type="number" step="1" data-ang value="' + r.angle + '"></td>' +
          '<td class="seg-dx">—</td>' +
          '<td class="seg-dy">—</td>' +
          '<td><button type="button" class="icon-btn" data-del title="Удалить отрезок">×</button></td>' +
        '</tr>';
      }).join('');
      updatePreview();
    }

    openModal('Скат по отрезкам', body, function () {
      const data = computePoints();
      if (data.rows.length < 2) {
        alert('Нужно минимум 2 отрезка.');
        return false;
      }
      if (data.rows.some(function (r) { return !(r.length > 0); })) {
        alert('Длина каждого отрезка должна быть больше нуля.');
        return false;
      }
      const norm = KP.normalizePoints(data.points);
      if (!(norm.width > 0) || !(norm.height > 0) || KP.polygonArea(norm.points) < 0.05) {
        alert('Не удалось построить скат: проверьте длины и углы.');
        return false;
      }
      const slope = KP.newSlope(project, activeMaterialId);
      slope.shape = 'polygon';
      slope.points = norm.points;
      slope.width = norm.width;
      slope.height = norm.height;
      slope.topWidth = 0;
      slope.name = nextSlopeName();
      placeSlopeClearOfOthers(slope);
      project.slopes.push(slope);
      selectedId = slope.id;
      renderAll();
      return true;
    });

    renderRows();

    const tbody = document.getElementById('segRows');
    tbody.addEventListener('input', updatePreview);
    tbody.addEventListener('click', function (ev) {
      const btn = ev.target.closest('[data-del]');
      if (!btn) return;
      const tr = btn.closest('tr[data-row]');
      const index = parseInt(tr.getAttribute('data-row'), 10);
      syncRows();
      rows.splice(index, 1);
      renderRows();
    });
    document.getElementById('segAdd').addEventListener('click', function () {
      syncRows();
      rows.push({ length: 5, angle: 0 });
      renderRows();
    });
    document.getElementById('segReset').addEventListener('click', function () {
      rows.length = 0;
      [{ length: 10, angle: 0 }, { length: 5, angle: 90 },
       { length: 10, angle: 180 }, { length: 5, angle: 270 }].forEach(function (r) { rows.push(r); });
      renderRows();
    });
    ['segStartX', 'segStartY'].forEach(function (id) {
      const input = document.getElementById(id);
      if (input) input.addEventListener('input', updatePreview);
    });
  }

  /* ---------- скат по координатам ---------- */

  function openCoordsModal(existingSlope) {
    const isEdit = !!existingSlope;
    const baseSlope = existingSlope || KP.newSlope(project, activeMaterialId);
    const materialId = baseSlope.materialId || (project.materials[0] && project.materials[0].id) || '';
    const initialPoints = existingSlope
      ? KP.slopePoints(existingSlope).map(function (p) { return { x: p[0], y: p[1] }; })
      : [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }];
    // В диалоге Y направлена вверх (от карниза к коньку), внутри проекта —
    // вниз, поэтому при показе и сохранении переворачиваем координаты.
    const initialHeight = initialPoints.reduce(function (max, p) {
      return Math.max(max, KP.num(p.y));
    }, 0);
    const rows = initialPoints.map(function (p) {
      return {
        x: Number(KP.num(p.x).toFixed(3)),
        y: Number((initialHeight - KP.num(p.y)).toFixed(3))
      };
    });
    const nameValue = isEdit ? String(baseSlope.name || 'Скат') : nextSlopeName();

    const body =
      '<div class="coords-layout">' +
        '<div class="coords-col">' +
          '<div class="form-grid">' +
            '<div class="field"><label>Название ската</label><input id="coordName" type="text" value="' +
              escText(nameValue) + '"></div>' +
            '<div class="field"><label>Материал</label><select id="coordMaterial">' +
              materialOptionList(materialId) + '</select></div>' +
          '</div>' +
          '<p class="shape-hint">Введите координаты вершин контура в метрах: X — вправо, Y — вверх, ' +
            '(0;0) — левый нижний угол контура. Порядок обхода — по часовой или против часовой стрелки. ' +
            'Контур замыкается автоматически, координаты нормализуются к (0; 0).</p>' +
          '<table class="segments-table coords-table">' +
            '<thead><tr><th>№</th><th>X, м</th><th>Y, м</th><th>Отрезок, м</th><th></th></tr></thead>' +
            '<tbody id="coordRows"></tbody>' +
          '</table>' +
          '<div class="segments-actions">' +
            '<button type="button" class="btn ghost small" id="coordAdd">+ Вершина</button>' +
            '<button type="button" class="btn ghost small" id="coordRect">Прямоугольник 10×5</button>' +
            '<button type="button" class="btn ghost small" id="coordClear">Очистить</button>' +
          '</div>' +
        '</div>' +
        '<div class="coords-col coords-col-preview">' +
          '<div class="coords-preview" id="coordPreview"></div>' +
          '<div class="shape-preview" id="coordSummary"></div>' +
          '<p class="shape-hint">Предпросмотр строится сразу по введённым координатам.</p>' +
        '</div>' +
      '</div>';

    function readRows() {
      const tbody = document.getElementById('coordRows');
      if (!tbody) return [];
      const result = [];
      tbody.querySelectorAll('tr[data-row]').forEach(function (tr) {
        result.push({
          x: KP.num(tr.querySelector('[data-x]').value),
          y: KP.num(tr.querySelector('[data-y]').value)
        });
      });
      return result;
    }

    function syncRows() {
      const current = readRows();
      rows.length = 0;
      current.forEach(function (p) { rows.push(p); });
    }

    function cleanRows() {
      const raw = readRows();
      const out = [];
      raw.forEach(function (p) {
        const last = out[out.length - 1];
        if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) {
          out.push(p);
        }
      });
      if (out.length > 1) {
        const first = out[0];
        const last = out[out.length - 1];
        if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) out.pop();
      }
      return out;
    }

    function preview() {
      const previewBox = document.getElementById('coordPreview');
      const summaryBox = document.getElementById('coordSummary');
      if (!previewBox || !summaryBox) return;

      const raw = readRows();
      const tbody = document.getElementById('coordRows');
      if (tbody) {
        tbody.querySelectorAll('tr[data-row]').forEach(function (tr, index) {
          const cell = tr.querySelector('.coord-delta');
          if (!cell) return;
          if (index === 0) { cell.textContent = '—'; return; }
          const prev = raw[index - 1];
          const cur = raw[index];
          cell.textContent = KP.fmt(Math.hypot(cur.x - prev.x, cur.y - prev.y));
        });
      }

      const userPts = cleanRows();
      if (userPts.length < 2) {
        previewBox.innerHTML = '<div class="coords-empty">Введите координаты минимум двух вершин</div>';
        summaryBox.textContent = 'Вершин: ' + userPts.length + ' · пока нельзя построить контур';
        return;
      }
      // Предпросмотр рисуется в экранных координатах, поэтому
      // отражаем Y, чтобы верх на картинке соответствовал верху ската.
      const pts = userPts.map(function (p) { return { x: p.x, y: -p.y }; });

      const xs = pts.map(function (p) { return p.x; });
      const ys = pts.map(function (p) { return p.y; });
      const minX = Math.min.apply(null, xs);
      const maxX = Math.max.apply(null, xs);
      const minY = Math.min.apply(null, ys);
      const maxY = Math.max.apply(null, ys);
      const w = Math.max(0.001, maxX - minX);
      const h = Math.max(0.001, maxY - minY);
      const pad = Math.max(0.3, Math.max(w, h) * 0.14);
      const stroke = Math.max(0.008, Math.max(w, h) / 220);
      const fontSize = Math.max(0.12, Math.max(w, h) * 0.035);
      const r = Math.max(0.05, Math.max(w, h) * 0.012);

      let chain = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        chain += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      }
      const closure = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
      const area = pts.length >= 3 ? KP.polygonArea(pts) : 0;
      const pointsAttr = pts.map(function (p) { return p.x + ',' + p.y; }).join(' ');

      let svg = '<svg viewBox="' + (minX - pad) + ' ' + (minY - pad) + ' ' +
        (w + pad * 2) + ' ' + (h + pad * 2) + '" preserveAspectRatio="xMidYMid meet" class="coords-svg">';
      svg += '<rect x="' + (minX - pad) + '" y="' + (minY - pad) + '" width="' + (w + pad * 2) +
        '" height="' + (h + pad * 2) + '" fill="#ffffff"/>';
      svg += '<polygon points="' + pointsAttr + '" fill="#d7202a" fill-opacity="0.08" ' +
        'stroke="#d7202a" stroke-width="' + stroke + '" stroke-linejoin="round"/>';

      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if (i === pts.length - 1 && closure < 1e-6) continue;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length < Math.max(w, h) * 0.12) continue;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        svg += '<text x="' + mx + '" y="' + (my - fontSize * 0.35) + '" text-anchor="middle" ' +
          'font-size="' + fontSize + '" fill="#8a6a6c" font-family="Geologica, Segoe UI, Arial, sans-serif">' +
          KP.fmt(length) + ' м</text>';
      }

      pts.forEach(function (p, index) {
        svg += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="' +
          (index === 0 ? '#d7202a' : '#ffffff') + '" stroke="#d7202a" stroke-width="' + stroke + '"/>';
        svg += '<text x="' + (p.x + fontSize * 0.5) + '" y="' + (p.y - fontSize * 0.5) + '" ' +
          'font-size="' + fontSize + '" fill="#272727" font-family="Geologica, Segoe UI, Arial, sans-serif">' +
          (index + 1) + '</text>';
      });

      svg += '</svg>';
      previewBox.innerHTML = svg;

      summaryBox.textContent = 'Вершин: ' + pts.length + ' · Площадь: ' + KP.fmt(area) +
        ' м² · Периметр: ' + KP.fmt(chain + closure) + ' м · Замыкающий отрезок: ' +
        KP.fmt(closure) + ' м' +
        (pts.length >= 3 && area < 0.05 ? ' · контур слишком мал' : '');
    }

    function renderRows() {
      const tbody = document.getElementById('coordRows');
      if (!tbody) return;
      tbody.innerHTML = rows.map(function (p, index) {
        return '<tr data-row="' + index + '">' +
          '<td>' + (index + 1) + '</td>' +
          '<td><input type="number" step="0.01" data-x value="' + numericInput(p.x) + '"></td>' +
          '<td><input type="number" step="0.01" data-y value="' + numericInput(p.y) + '"></td>' +
          '<td class="coord-delta">—</td>' +
          '<td><button type="button" class="icon-btn" data-del title="Удалить вершину">×</button></td>' +
        '</tr>';
      }).join('');
      preview();
    }

    openModal(isEdit ? 'Скат по координатам' : 'Новый скат по координатам', body, function () {
      const userPts = cleanRows();
      if (userPts.length < 3) {
        alert('Введите минимум 3 вершины контура.');
        return false;
      }
      const userMaxY = userPts.reduce(function (max, p) { return Math.max(max, p.y); }, 0);
      const pts = userPts.map(function (p) {
        return { x: p.x, y: Number((userMaxY - p.y).toFixed(3)) };
      });
      const norm = KP.normalizePoints(pts);
      if (!(norm.width > 0) || !(norm.height > 0) || KP.polygonArea(norm.points) < 0.05) {
        alert('Не удалось построить скат: проверьте координаты вершин.');
        return false;
      }

      const slope = existingSlope || KP.newSlope(project, document.getElementById('coordMaterial').value);
      slope.shape = 'polygon';
      slope.points = norm.points;
      slope.width = norm.width;
      slope.height = norm.height;
      slope.topWidth = 0;
      slope.name = document.getElementById('coordName').value.trim() || nextSlopeName();
      slope.materialId = document.getElementById('coordMaterial').value;
      if (existingSlope) slope.sheetLengthDeltas = [];
      if (!existingSlope) {
        placeSlopeClearOfOthers(slope);
        project.slopes.push(slope);
      }
      selectedId = slope.id;
      renderAll();
      return true;
    }, { wide: true });

    renderRows();

    const tbody = document.getElementById('coordRows');
    tbody.addEventListener('input', preview);
    tbody.addEventListener('click', function (ev) {
      const btn = ev.target.closest('[data-del]');
      if (!btn) return;
      const tr = btn.closest('tr[data-row]');
      if (!tr) return;
      const index = parseInt(tr.getAttribute('data-row'), 10);
      syncRows();
      rows.splice(index, 1);
      renderRows();
    });
    document.getElementById('coordAdd').addEventListener('click', function () {
      syncRows();
      const last = rows[rows.length - 1] || { x: 0, y: 0 };
      rows.push({ x: Number((last.x + 5).toFixed(3)), y: Number(last.y.toFixed(3)) });
      renderRows();
    });
    document.getElementById('coordRect').addEventListener('click', function () {
      rows.length = 0;
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }].forEach(function (p) {
        rows.push(p);
      });
      renderRows();
    });
    document.getElementById('coordClear').addEventListener('click', function () {
      rows.length = 0;
      rows.push({ x: 0, y: 0 });
      renderRows();
    });
  }

  /* ---------- шаблоны ---------- */

  function renderTemplatesMenu() {
    templatesMenu.innerHTML = KP.templates.map(function (t) {
      return '<button data-template="' + t.id + '">' + t.name +
        '<small>' + t.note + '</small></button>';
    }).join('') +
      '<button data-shape-library="1">Формы скатов<small>Библиотека из 42 форм — вставка по размерам</small></button>';
    templatesMenu.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.hasAttribute('data-shape-library')) {
          templatesMenu.classList.add('hidden');
          openShapeModal(null, 'dims');
          return;
        }
        const template = KP.templates.find(function (t) { return t.id === btn.getAttribute('data-template'); });
        if (!template) return;
        if (project.slopes.length && !confirm('Заменить текущие скаты шаблоном «' + template.name + '»?')) return;
        project.slopes = template.build(project);
        selectedId = project.slopes.length ? project.slopes[0].id : null;
        templatesMenu.classList.add('hidden');
        renderAll();
      });
    });
  }

  /* ---------- элементы ---------- */

  function fillElementCatalog() {
    const select = $('#elementCatalog');
    select.innerHTML = KP.elementsCatalog().map(function (item, index) {
      return '<option value="' + index + '">' + item.name + ' — ' + item.price + ' ₽/' + item.unit + '</option>';
    }).join('');
  }

  function addElementFromForm() {
    const catalog = KP.elementsCatalog();
    const item = catalog[parseInt($('#elementCatalog').value, 10)];
    if (!item) return;
    project.elements.push({
      id: KP.uid('el'),
      name: item.name,
      unit: item.unit,
      qty: KP.num($('#elementQty').value) || 1,
      price: item.price
    });
    renderAll();
  }

  function autoElements() {
    if (!project.slopes.length) {
      alert('Сначала добавьте хотя бы один скат.');
      return;
    }
    if (project.elements.length && !confirm('Добавить типовые доборы к уже существующим?')) return;

    const added = [];
    const push = function (name, qty, unit, price) {
      const q = Math.max(0, Math.ceil(qty * 1.1 * 10) / 10);
      if (q <= 0) return;
      project.elements.push({ id: KP.uid('el'), name: name, unit: unit, qty: q, price: price });
      added.push(name);
    };

    project.slopes.forEach(function (slope, index) {
      const n = index + 1;
      const w = KP.num(slope.width);
      const h = KP.num(slope.height);
      const tw = Math.max(0, Math.min(KP.num(slope.topWidth), w));
      const side = slope.shape === 'rect'
        ? h
        : (slope.shape === 'trapezoid' ? Math.hypot(h, (w - tw) / 2) : Math.hypot(h, w / 2));

      push('Карнизная планка (скат ' + n + ')', w, 'м', 600);
      push('Торцевая планка (скат ' + n + ')', side * 2, 'м', 650);
      if (slope.shape !== 'triangle' && tw > 0) {
        push('Конёк (скат ' + n + ')', tw, 'м', 850);
      }
    });

    const totalArea = KP.calcProject(project).totals.fullArea;
    if (totalArea > 0) {
      push('Саморезы кровельные', Math.ceil(totalArea * 8), 'шт', 8);
    }

    renderAll();
    alert('Добавлено позиций: ' + added.length + '.');
  }

  /* ---------- проект ---------- */

  function updateProjectFields() {
    const nameInput = $('#projectName');
    const customerInput = $('#projectCustomer');
    if (document.activeElement !== nameInput) nameInput.value = project.name || '';
    if (document.activeElement !== customerInput) customerInput.value = project.customer || '';
  }

  function syncDrawToggles() {
    if (!canvasApi) return;
    const settings = canvasApi.getDrawSettings();
    $$('.status-toggles [data-toggle]').forEach(function (btn) {
      btn.classList.toggle('active', !!settings[btn.getAttribute('data-toggle')]);
    });
    const snapStep = $('#snapStep');
    if (snapStep) snapStep.value = String(settings.snapStep);
    const polarStep = $('#polarStep');
    if (polarStep) polarStep.value = String(settings.polarStep);
  }

  function applyPolarFromInputs() {
    if (!canvasApi || !canvasApi.isDrawing()) return;
    const length = KP.num($('#polarLength').value);
    const angle = KP.num($('#polarAngle').value);
    if (!(length > 0)) return;
    canvasApi.addPolarPoint(length, angle);
    const lengthInput = $('#polarLength');
    if (lengthInput) {
      lengthInput.value = '';
      lengthInput.focus();
    }
  }

  function setSelectTool() {
    if (canvasApi && canvasApi.isDrawing()) canvasApi.cancelDraw();
    [
      $('#btnToolPolyline'), $('#railCoords'),
      $('#btnToolLine'), $('#railLine')
    ].filter(Boolean).forEach(function (btn) { btn.classList.remove('active'); });
    [$('#btnToolSelect'), $('#railSelect')].filter(Boolean).forEach(function (btn) {
      btn.classList.add('active');
    });
  }

  function startPolygonDrawing(mode) {
    if (!canvasApi) return;
    if (canvasApi.isDrawing()) canvasApi.cancelDraw();
    const drawMode = mode === 'line' ? 'line' : 'polyline';
    const allToolButtons = [
      $('#btnToolSelect'), $('#railSelect'),
      $('#btnToolPolyline'), $('#railCoords'),
      $('#btnToolLine'), $('#railLine')
    ].filter(Boolean);
    // Инструменты взаимоисключающие: снимаем подсветку со всех,
    // иначе после переключения «полилиния → отрезок» горят обе кнопки.
    allToolButtons.forEach(function (btn) { btn.classList.remove('active'); });
    const toolButtons = drawMode === 'line'
      ? [$('#btnToolLine'), $('#railLine')].filter(Boolean)
      : [$('#btnToolPolyline'), $('#railCoords')].filter(Boolean);
    toolButtons.forEach(function (btn) { btn.classList.add('active'); });
    const previousScale = canvasApi.getScale();
    // Немного отдаляемся, чтобы вокруг существующих скатов было видно
    // свободное место и первую точку можно было поставить вне контура.
    canvasApi.fitView(1.4);

    canvasApi.startPolygonDraw({
      mode: drawMode,
      onFinish: function (points) {
        canvasApi.setScale(previousScale);
        setSelectTool();
        const norm = KP.normalizePoints(points.map(function (p) { return { x: p.x, y: p.y }; }));
        if (!(norm.width > 0) || !(norm.height > 0) || KP.polygonArea(norm.points) < 0.05) {
          alert('Фигура не построена: слишком мала площадь.');
          renderAll();
          return;
        }
        const slope = KP.newSlope(project, activeMaterialId);
        slope.shape = 'polygon';
        slope.points = norm.points;
        slope.width = norm.width;
        slope.height = norm.height;
        slope.topWidth = 0;
        slope.name = nextSlopeName();
        project.slopes.push(slope);
        selectedId = slope.id;
        selectedObjectId = null;
        renderAll();
        requestAnimationFrame(function () {
          canvasWrap.scrollLeft = canvasWrap.scrollWidth;
        });
      },
      onCancel: function () {
        canvasApi.setScale(previousScale);
        setSelectTool();
        renderAll();
      },
      onCursor: function (point) {
        const xInput = $('#tbX');
        const yInput = $('#tbY');
        if (xInput) xInput.value = KP.fmt(point.x);
        if (yInput) yInput.value = KP.fmt(point.y);
      },
      onState: function (active) {
        const hint = $('#drawHint');
        if (hint) hint.classList.toggle('hidden', !active);
        if (!active) {
          const lengthInput = $('#polarLength');
          const angleInput = $('#polarAngle');
          if (lengthInput) lengthInput.value = '';
          if (angleInput) angleInput.value = '';
        }
      }
    });
  }

  function addSlope() {
    // Показываем выбор способа создания ската (координаты, размеры,
    // библиотека форм), а не сразу вставляем прямоугольник.
    openShapeModal(null, 'dims');
  }

  function duplicateSelected() {
    const slope = selectedSlope();
    if (!slope) { alert('Скат не выбран.'); return; }
    const copy = KP.clone(slope);
    copy.id = KP.uid('slope');
    copy.name = nextSlopeName();
    // Копия не должна накладываться на сдвинутый оригинал.
    copy.dragOffset = { x: 0, y: 0 };
    placeSlopeClearOfOthers(copy);
    project.slopes.push(copy);
    selectedId = copy.id;
    selectedObjectId = null;
    renderAll();
  }

  function deleteSelected() {
    const slope = selectedSlope();
    if (!slope) { alert('Скат не выбран.'); return; }
    if (!confirm('Удалить скат «' + slope.name + '»?')) return;
    project.slopes = project.slopes.filter(function (s) { return s.id !== slope.id; });
    selectedId = project.slopes.length ? project.slopes[0].id : null;
    renderAll();
  }

  function deleteCurrentSelection() {
    if (selectedObjectId) {
      const object = selectedDrawingObject();
      if (object) { deleteDrawingObject(object); return; }
      selectedObjectId = null;
    }
    if (selectedId) { deleteSelected(); return; }
    alert('Ничего не выбрано. Выберите скат или объект на чертеже.');
  }

  function renderDrawingElements() {
    const box = $('#drawingElements');
    if (!box) return;
    if (!project.slopes.length) {
      box.innerHTML = '<p class="panel-note">Скаты не добавлены</p>';
      return;
    }
    box.innerHTML = project.slopes.map(function (slope) {
      return '<div class="el-item ' + (slope.id === selectedId ? 'active' : '') + '" data-id="' + slope.id + '">' +
        '<div><div class="el-name">' + escText(slope.name) + '</div>' +
        '<div class="el-meta">' + KP.shapeLabel(slope.shape) + ' · ' + KP.fmt(slope.width) +
        ' × ' + KP.fmt(slope.height) + ' м</div></div>' +
      '</div>';
    }).join('');
    box.querySelectorAll('.el-item').forEach(function (item) {
      item.addEventListener('click', function () {
        selectedId = item.getAttribute('data-id');
        selectedObjectId = null;
        renderAll();
      });
    });
  }

  function renderObjectsPanel() {
    const box = $('#objectList');
    const count = $('#objectCount');
    const section = $('#objectsSection');
    const objects = project.objects || [];
    if (count) count.textContent = String(objects.length);
    if (section) section.classList.toggle('hidden', !objects.length);
    if (!box) return;
    if (!objects.length) {
      box.innerHTML = '<p class="panel-note">Объекты не импортированы</p>';
      return;
    }
    box.innerHTML = objects.map(function (obj, index) {
      const name = obj.kind === 'text'
        ? ('Текст: ' + obj.text)
        : (objectKindLabel(obj.kind) + (obj.closed ? ' · контур' : ''));
      return '<div class="el-item ' + (obj.id === selectedObjectId ? 'active' : '') + '" data-object-id="' +
        obj.id + '"><span class="el-num">' + (index + 1) + '</span>' +
        '<div style="min-width:0"><div class="el-name">' + escText(name) + '</div>' +
        '<div class="el-meta">' + escText(objectMeta(obj)) + '</div></div></div>';
    }).join('');
    box.querySelectorAll('[data-object-id]').forEach(function (item) {
      item.addEventListener('click', function () {
        selectedObjectId = item.getAttribute('data-object-id');
        selectedId = null;
        renderAll();
      });
    });
  }

  function renderSheetTabs() {
    const box = $('#sheetTabs');
    if (!box) return;
    box.innerHTML = project.slopes.map(function (slope, index) {
      return '<button class="sheet-tab ' + (slope.id === selectedId ? 'active' : '') +
        '" data-id="' + slope.id + '" title="' + escText(slope.name) + '">' + (index + 1) + '</button>';
    }).join('') + '<button class="sheet-add" data-add="1" title="Добавить скат">+</button>';
    box.querySelectorAll('.sheet-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectedId = btn.getAttribute('data-id');
        selectedObjectId = null;
        renderAll();
      });
    });
    const addBtn = box.querySelector('[data-add]');
    if (addBtn) addBtn.addEventListener('click', addSlope);
  }

  function renderToolbarFields() {
    const slope = selectedSlope();
    const material = slope ? KP.getMaterial(project, slope.materialId) : null;
    const widthInput = $('#tbWidth');
    if (!widthInput) return;
    widthInput.value = material ? KP.fmt(material.fullWidth) : '—';
    $('#tbUseful').value = material ? KP.fmt(material.usefulWidth) : '—';
    let x = 0;
    if (slope) {
      for (let i = 0; i < project.slopes.length; i++) {
        if (project.slopes[i].id === slope.id) break;
        x += KP.num(project.slopes[i].width) + 2.2;
      }
    }
    $('#tbX').value = slope ? KP.fmt(x) : '0,00';
    $('#tbY').value = '0,00';
    const lengthInput = $('#tbLength');
    if (document.activeElement !== lengthInput) {
      lengthInput.value = slope ? Number(KP.num(slope.height).toFixed(2)) : '';
    }
    updateZoomLabel();
  }

  function renderStatusInfo() {
    if (!project.id) project.id = KP.uid('calc');
    const info = $('#statusInfo');
    if (info) info.textContent = 'id: ' + project.id + '   Файл: ' + (project.name || 'без названия');
  }

  function insertImageUnderlay(file) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      alert('Файл больше 4 МБ — подложка может не сохраниться в браузере.');
    }
    const reader = new FileReader();
    reader.onload = function () {
      const dataUrl = reader.result;
      const img = new Image();
      img.onload = function () {
        let source = dataUrl;
        let pxW = img.width;
        let pxH = img.height;
        try {
          const maxSide = 1600;
          const ratio = Math.min(1, maxSide / Math.max(pxW, pxH));
          const cw = Math.max(1, Math.round(pxW * ratio));
          const ch = Math.max(1, Math.round(pxH * ratio));
          const canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          source = canvas.toDataURL('image/jpeg', 0.82);
          pxW = cw;
          pxH = ch;
        } catch (e) { /* оставляем исходное изображение */ }

        const width = 50;
        const height = width * (pxH / pxW || 1);
        project.underlay = {
          name: file.name,
          dataUrl: source,
          x: -width - 5,
          y: 0,
          width: width,
          height: Number(height.toFixed(2)),
          opacity: 0.45,
          visible: true
        };
        renderAll();
        if (canvasApi) canvasApi.fitView();
      };
      img.onerror = function () { alert('Не удалось прочитать изображение.'); };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  function deleteUnderlay() {
    if (!project.underlay) return;
    if (!confirm('Удалить подложку?')) return;
    project.underlay = null;
    renderAll();
  }

  function showDwgBusy(text) {
    modalRoot.innerHTML =
      '<div class="modal-backdrop dwg-backdrop">' +
        '<div class="modal dwg-busy" role="dialog" aria-modal="true">' +
          '<div class="modal-head"><h3>Импорт DWG</h3></div>' +
          '<div class="modal-body dwg-busy-body">' +
            '<div class="dwg-spinner"></div>' +
            '<p id="dwgBusyText">' + escText(text) + '</p>' +
            '<p class="shape-hint">Первый импорт загружает модуль чтения DWG (около 11 МБ). ' +
            'Это может занять несколько секунд.</p>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function updateDwgBusy(text) {
    const el = document.getElementById('dwgBusyText');
    if (el) el.textContent = text;
  }

  function hideDwgBusy() {
    modalRoot.innerHTML = '';
  }

  function importDwgUnderlayFile(file) {
    if (!file) return;
    if (project.underlay && !confirm('Заменить текущую подложку чертежом «' + file.name + '»?')) {
      return;
    }

    showDwgBusy('Подготовка…');
    KP.dwg.importFile(file, updateDwgBusy, { mode: 'underlay' }).then(function (result) {
      const box = result.viewBox || { width: 1, height: 1 };
      const ratio = box.width > 0 ? box.height / box.width : 0.7;
      const width = 50;
      const height = Math.max(1, Number((width * ratio).toFixed(2)));

      project.underlay = {
        name: file.name,
        dataUrl: result.dataUrl,
        x: -width - 5,
        y: 0,
        width: width,
        height: height,
        opacity: 0.55,
        visible: true,
        source: 'dwg',
        meta: {
          total: result.total,
          types: result.counts,
          pixelWidth: result.width,
          pixelHeight: result.height,
          aspect: box.width > 0 ? Number((box.height / box.width).toFixed(6)) : null,
          raster: result.raster,
          debug: result.debug || null
        }
      };

      hideDwgBusy();
      renderAll();
      if (canvasApi) canvasApi.fitView();

      const types = Object.keys(result.counts || {})
        .sort(function (a, b) { return result.counts[b] - result.counts[a]; })
        .slice(0, 6)
        .map(function (type) { return type + ' — ' + result.counts[type]; })
        .join('\n');
      setTimeout(function () {
        alert('DWG загружен как подложка.\nОбъектов: ' + result.total +
          (types ? '\n' + types : '') +
          '\n\nРазмер и положение подложки настраиваются в панели «Подложка».');
      }, 30);
    }).catch(function (err) {
      hideDwgBusy();
      alert('Не удалось загрузить DWG:\n' + (err && err.message ? err.message : err));
    }).then(function () {
      const input = $('#fileDwg');
      if (input) input.value = '';
    });
  }

  function importDwgObjectsFile(file, unit, hideUnderlay) {
    if (!file) return;
    if ((project.objects || []).length && !confirm('Заменить объекты чертежа «' + file.name + '»?')) return;

    showDwgBusy('Подготовка…');
    KP.dwg.importFile(file, updateDwgBusy, {
      mode: 'objects',
      unit: unit || 'mm',
      targetWidth: 60
    }).then(function (result) {
      // Размещаем импортированный чертёж слева от существующих скатов.
      const slopeWidth = project.slopes.reduce(function (sum, slope) {
        return sum + Math.max(0.2, KP.num(slope.width));
      }, 0) + Math.max(0, project.slopes.length - 1) * 2.2;
      const offsetX = project.slopes.length ? -(slopeWidth + 5) : 0;

      project.objects = (result.objects || []).map(function (obj) {
        const item = KP.clone(obj);
        if (item.kind === 'circle') {
          item.cx = Number((item.cx + offsetX).toFixed(3));
        } else if (item.kind === 'text') {
          item.x = Number((item.x + offsetX).toFixed(3));
        } else if (Array.isArray(item.points)) {
          item.points = item.points.map(function (p) {
            return { x: Number((p.x + offsetX).toFixed(3)), y: p.y };
          });
        }
        return item;
      });
      selectedObjectId = null;
      if (hideUnderlay && project.underlay) project.underlay.visible = false;

      hideDwgBusy();
      renderAll();
      if (canvasApi) canvasApi.fitView();

      const types = Object.keys(result.counts || {})
        .sort(function (a, b) { return result.counts[b] - result.counts[a]; })
        .slice(0, 6)
        .map(function (type) { return type + ' — ' + result.counts[type]; })
        .join('\n');
      setTimeout(function () {
        alert('DWG загружен как редактируемый чертёж.\n' +
          'Создано объектов: ' + result.supported + '.\n' +
          (types ? types + '\n' : '') +
          (offsetX ? '\nЧертёж размещён слева от скатов.\n' : '') +
          '\nОбъекты можно выбирать, перемещать мышью, редактировать двойным щелчком и удалять. ' +
          'Замкнутый контур можно превратить в скат.');
      }, 30);
    }).catch(function (err) {
      hideDwgBusy();
      alert('Не удалось загрузить DWG:\n' + (err && err.message ? err.message : err));
    }).then(function () {
      const input = $('#fileDwg');
      if (input) input.value = '';
    });
  }

  function openDwgImportModal(file) {
    if (!file) return;
    const input = $('#fileDwg');
    if (input) input.value = '';

    const body =
      '<p class="shape-hint">Файл: <b>' + escText(file.name) + '</b></p>' +
      '<div class="field"><label>Что импортировать</label><select id="dwgMode">' +
        '<option value="objects">Редактируемый чертёж — объекты</option>' +
        '<option value="underlay">Подложка — растровое изображение</option>' +
      '</select></div>' +
      '<div class="field" id="dwgUnitField"><label>Масштаб чертежа</label><select id="dwgUnit">' +
        '<option value="mm" selected>1:1 — миллиметры</option>' +
        '<option value="auto">Авто — вписать в 60 м</option>' +
        '<option value="cm">1:1 — сантиметры</option>' +
        '<option value="m">1:1 — метры</option>' +
      '</select></div>' +
      (project.underlay
        ? '<label class="check-row" id="dwgHideUnderlayRow"><input id="dwgHideUnderlay" type="checkbox"' +
          (project.underlay.visible !== false ? ' checked' : '') + '> Скрыть текущую подложку</label>'
        : '') +
      '<p class="shape-hint">Линии, полилинии, окружности и текст DWG станут объектами чертежа. ' +
        'Их можно выбирать, перемещать мышью, редактировать и удалять. ' +
        'Из замкнутого контура можно создать скат для расчёта.</p>';

    openModal('Импорт DWG', body, function () {
      const modeEl = document.getElementById('dwgMode');
      const unitEl = document.getElementById('dwgUnit');
      const hideEl = document.getElementById('dwgHideUnderlay');
      const mode = modeEl ? modeEl.value : 'objects';
      const unit = unitEl ? unitEl.value : 'mm';
      const hideUnderlay = !!(hideEl && hideEl.checked);
      // Даём модальному окну закрыться, затем показываем прогресс.
      setTimeout(function () {
        if (mode === 'underlay') importDwgUnderlayFile(file);
        else importDwgObjectsFile(file, unit, hideUnderlay);
      }, 60);
      return true;
    }, { saveLabel: 'Импортировать' });

    const modeSelect = document.getElementById('dwgMode');
    const unitField = document.getElementById('dwgUnitField');
    const hideRow = document.getElementById('dwgHideUnderlayRow');
    if (modeSelect && unitField) {
      modeSelect.addEventListener('change', function () {
        const isObjects = modeSelect.value === 'objects';
        unitField.classList.toggle('hidden', !isObjects);
        if (hideRow) hideRow.classList.toggle('hidden', !isObjects);
      });
    }
  }

  function renderUnderlayPanel() {
    const section = $('#underlaySection');
    if (!section) return;
    const u = project.underlay;
    section.classList.toggle('hidden', !u);
    if (!u) return;
    const name = $('#underlayName');
    if (name) {
      name.textContent = u.name || 'изображение';
      name.title = u.name || '';
    }
    const meta = $('#underlayMeta');
    if (meta) {
      if (u.source === 'dwg') {
        meta.textContent = 'DWG · объектов: ' + (u.meta && u.meta.total ? u.meta.total : '—');
        meta.title = u.meta && u.meta.pixelWidth
          ? 'Растр ' + u.meta.pixelWidth + '×' + u.meta.pixelHeight
          : '';
      } else {
        meta.textContent = 'Изображение';
        meta.title = '';
      }
    }
    const map = { underlayX: 'x', underlayY: 'y', underlayW: 'width', underlayOpacity: 'opacity' };
    Object.keys(map).forEach(function (id) {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) el.value = u[map[id]];
    });
  }

  function bindUnderlayPanel() {
    const map = { underlayX: 'x', underlayY: 'y', underlayW: 'width' };
    Object.keys(map).forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', function () {
        if (!project.underlay) return;
        const underlay = project.underlay;
        const oldWidth = KP.num(underlay.width) || 1;
        const oldHeight = KP.num(underlay.height) || 1;
        const value = KP.num(el.value);
        underlay[map[id]] = value;
        if (id === 'underlayW') {
          const aspect = underlay.meta && underlay.meta.aspect
            ? underlay.meta.aspect
            : oldHeight / oldWidth;
          underlay.height = Number((value * aspect).toFixed(2));
        }
        renderAll();
      });
    });
    const opacity = $('#underlayOpacity');
    if (opacity) {
      opacity.addEventListener('input', function () {
        if (!project.underlay) return;
        project.underlay.opacity = KP.num(opacity.value);
        renderAll();
      });
    }
    const remove = $('#underlayDelete');
    if (remove) remove.addEventListener('click', deleteUnderlay);
  }

  function mirrorSelected() {
    const slope = selectedSlope();
    if (!slope) { alert('Скат не выбран.'); return; }
    if (slope.shape !== 'polygon' || !Array.isArray(slope.points) || slope.points.length < 3) {
      alert('Отражение доступно для многоугольных фигур.');
      return;
    }
    const mirrored = slope.points.map(function (p) {
      return { x: Number((slope.width - p.x).toFixed(3)), y: p.y };
    });
    slope.points = KP.normalizePoints(mirrored).points;
    renderAll();
  }

  function rotateSelected() {
    const slope = selectedSlope();
    if (!slope) { alert('Скат не выбран.'); return; }
    const rotated = KP.slopePoints(slope).map(function (p) {
      return { x: Number((slope.height - p[1]).toFixed(3)), y: Number(p[0].toFixed(3)) };
    });
    const norm = KP.normalizePoints(rotated);
    slope.shape = 'polygon';
    slope.points = norm.points;
    slope.width = norm.width;
    slope.height = norm.height;
    slope.topWidth = 0;
    renderAll();
  }

  function scrollToPanel(selector) {
    const el = $(selector);
    if (!el) return;
    const details = el.closest('details');
    if (details) details.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function toggleMaterials(show) {
    const drawer = $('#materialsDrawer');
    if (!drawer) return;
    const open = typeof show === 'boolean' ? show : drawer.classList.contains('hidden');
    drawer.classList.toggle('hidden', !open);
  }

  function updatePinBottomButton() {
    const button = $('#btnPinBottom');
    if (!button) return;
    button.classList.toggle('active', bottomPinned);
    button.setAttribute('aria-pressed', bottomPinned ? 'true' : 'false');
    button.title = bottomPinned ? 'Открепить панель' : 'Закрепить панель';
  }

  function applyBottomHeight(height) {
    const drawer = $('#bottomDrawer');
    if (!drawer) return;
    const maxHeight = Math.max(180, window.innerHeight - 150);
    const next = Math.max(110, Math.min(maxHeight, Math.round(KP.num(height))));
    drawer.style.height = next + 'px';
  }

  function saveBottomUi() {
    const drawer = $('#bottomDrawer');
    if (!drawer) return;
    try {
      localStorage.setItem(BOTTOM_UI_KEY, JSON.stringify({
        pinned: bottomPinned,
        tab: bottomTabName,
        open: !drawer.classList.contains('hidden'),
        height: Math.round(drawer.getBoundingClientRect().height)
      }));
    } catch (e) { /* localStorage может быть недоступен */ }
  }

  function startDrawerResize(ev) {
    const drawer = $('#bottomDrawer');
    if (!drawer) return;
    ev.preventDefault();
    const startY = ev.clientY;
    const startHeight = drawer.getBoundingClientRect().height;
    const onMove = function (moveEvent) {
      applyBottomHeight(startHeight + (startY - moveEvent.clientY));
    };
    const onUp = function () {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      saveBottomUi();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    document.body.style.cursor = 'ns-resize';
  }

  function setBottomTab(name, open) {
    const drawer = $('#bottomDrawer');
    if (!drawer) return;
    bottomTabName = name || bottomTabName;
    if (open || bottomPinned) drawer.classList.remove('hidden');
    drawer.classList.toggle('layouts-active', bottomTabName === 'layouts');
    $$('#bottomDrawer .bottom-tabs .tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-tab') === bottomTabName);
    });
    $$('#bottomDrawer .tab-panel').forEach(function (panel) {
      panel.classList.toggle('hidden', panel.id !== 'tab-' + bottomTabName);
    });
    if (bottomTabName === 'layouts') renderLayoutPages(KP.calcProject(project));
    const toggle = $('#btnToggleCalc');
    if (toggle) toggle.classList.toggle('active', !drawer.classList.contains('hidden'));
    saveBottomUi();
  }

  function toggleBottom() {
    const drawer = $('#bottomDrawer');
    if (!drawer) return;
    if (bottomPinned) {
      setBottomTab(bottomTabName, true);
      return;
    }
    if (drawer.classList.contains('hidden')) {
      setBottomTab('elements', true);
    } else {
      drawer.classList.add('hidden');
      const toggle = $('#btnToggleCalc');
      if (toggle) toggle.classList.remove('active');
      saveBottomUi();
    }
  }

  function exportXls() {
    KP.exportXLS(project, KP.calcProject(project));
  }

  function exportPdf(options) {
    KP.exportPDF(project, KP.calcProject(project), canvasApi ? canvasApi.getSvg() : null, options);
  }

  function doAction(action) {
    switch (action) {
      case 'new':
        if (!confirm('Создать новый проект? Текущий проект будет заменён.')) return;
        project = KP.newProject();
        selectedId = null;
        selectedObjectId = null;
        activeType = 'tile';
        activeMaterialId = (project.materials[0] || {}).id || null;
        renderAll();
        break;
      case 'import':
        $('#fileImport').click();
        break;
      case 'exportJson':
        downloadJson();
        break;
      case 'exportPdf':
        exportPdf();
        break;
      case 'duplicate':
        duplicateSelected();
        break;
      case 'delete':
        deleteCurrentSelection();
        break;
      case 'clear':
        if (!confirm('Удалить все скаты, объекты чертежа и доборные элементы?')) return;
        project.slopes = [];
        project.objects = [];
        project.elements = [];
        selectedId = null;
        selectedObjectId = null;
        renderAll();
        break;
      case 'zoomIn':
        canvasApi.setScale(canvasApi.getScale() * 1.15);
        updateZoomLabel();
        break;
      case 'zoomOut':
        canvasApi.setScale(canvasApi.getScale() / 1.15);
        updateZoomLabel();
        break;
      case 'materials':
        toggleMaterials(true);
        break;
      case 'calcPanel':
        toggleBottom();
        break;
      case 'autoElements':
        autoElements();
        break;
      case 'xls':
        exportXls();
        break;
      case 'totals':
        setBottomTab('totals', true);
        break;
      case 'specification':
        setBottomTab('spec', true);
        break;
      case 'layoutPages':
        setBottomTab('layouts', true);
        break;
      case 'addMaterial':
        toggleMaterials(true);
        openMaterialModal(null);
        break;
      case 'shapeCoords':
        openCoordsModal(null);
        break;
      case 'shapeDims':
        openShapeModal(null, 'dims');
        break;
      case 'cutout':
        openCutoutModal();
        break;
      case 'templates':
        setTimeout(function () { templatesMenu.classList.remove('hidden'); }, 0);
        break;
      case 'reset':
        if (!confirm('Сбросить сохранённый проект и начать заново?')) return;
        try { localStorage.removeItem(KP.STORAGE_KEY); } catch (e) { /* ignore */ }
        project = KP.newProject();
        selectedId = null;
        selectedObjectId = null;
        activeType = 'tile';
        activeMaterialId = (project.materials[0] || {}).id || null;
        renderAll();
        break;
      case 'exportXls':
        exportXls();
        break;
      case 'undoPoint':
        if (canvasApi) canvasApi.undoLastPoint();
        break;
      case 'fitView':
        canvasApi.fitView();
        updateZoomLabel();
        break;
      case 'toggleGrid':
        canvasApi.toggleDrawSetting('showGrid');
        break;
      case 'toggleDimensions':
        canvasApi.toggleDrawSetting('showDimensions');
        break;
      case 'showDimensions':
        canvasApi.setDrawSetting('showDimensions', true);
        break;
      case 'hideDimensions':
        canvasApi.setDrawSetting('showDimensions', false);
        break;
      case 'insertElement':
        setBottomTab('elements', true);
        break;
      case 'insertImage':
        $('#fileUnderlay').click();
        break;
      case 'dwgImport':
        $('#fileDwg').click();
        break;
      case 'toggleUnderlay':
        if (!project.underlay) { alert('Подложка не вставлена.'); return; }
        project.underlay.visible = !project.underlay.visible;
        renderAll();
        break;
      case 'deleteUnderlay':
        deleteUnderlay();
        break;
      case 'insertBlock':
        alert('Вставка блоков появится позже. Используйте «Вставка → Шаблон кровли».');
        break;
      case 'layers':
        alert('Слои проекта:\n• Материалы\n• Раскладка листов\n• Размеры\n• Доборные элементы\n• Подложка');
        break;
      case 'units':
        alert('Единицы проекта — метры.\nВ исходном шаблоне AutoCAD — миллиметры.');
        break;
      case 'focusZoom':
        $('#tbZoom').focus();
        $('#tbZoom').select();
        break;
      case 'textStyle':
        alert('Стиль текста: Geologica.\nРедактор стилей появится позже.');
        break;
      case 'toggleOrtho':
      case 'togglePolar':
      case 'toggleSnap':
      case 'toggleOsnap':
        canvasApi.toggleDrawSetting({
          toggleOrtho: 'ortho',
          togglePolar: 'polar',
          toggleSnap: 'snap',
          toggleOsnap: 'osnap'
        }[action]);
        syncDrawToggles();
        break;
      case 'polyline':
        startPolygonDrawing('polyline');
        break;
      case 'lineDraw':
        startPolygonDrawing('line');
        break;
      case 'slopeSegments':
        openSegmentsModal();
        break;
      case 'slopeCoords':
        openCoordsModal(null);
        break;
      case 'layoutDwgContours':
        layoutDwgContours();
        break;
      case 'drawRect':
        openShapeModal(null, 'dims', 'rect');
        break;
      case 'drawTrapezoid':
        openShapeModal(null, 'dims', 'trapezoid');
        break;
      case 'drawTriangle':
        openShapeModal(null, 'dims', 'triangle');
        break;
      case 'focusPolar':
        if (!canvasApi.isDrawing()) startPolygonDrawing();
        setTimeout(function () {
          const input = $('#polarLength');
          if (input) input.focus();
        }, 0);
        break;
      case 'mirror':
        mirrorSelected();
        break;
      case 'rotate90':
        rotateSelected();
        break;
      case 'properties':
        scrollToPanel('#slopeProps');
        break;
      case 'elementsPanel':
        scrollToPanel('#drawingElements');
        break;
      case 'dimLinear':
      case 'dimAngular':
        alert('Размеры отображаются автоматически. Ручные размеры появятся позже.');
        break;
      case 'hotkeys':
        alert('Горячие клавиши:\n' +
          'Delete / Backspace — удалить выбранный элемент\n' +
          'F3 — объектная привязка\n' +
          'F8 — орто\n' +
          'F9 — привязка к сетке\n' +
          'F10 — полярное отслеживание\n' +
          'Shift — временное орто\n' +
          'Alt — отключить привязки\n' +
          'C — замкнуть контур\n' +
          'U / Ctrl+Z — убрать точку\n' +
          'Enter — завершить\n' +
          'Esc — отмена\n' +
          'Колесо — зум\n' +
          'Средняя кнопка — панорамирование');
        break;
      case 'installApp':
        if (installPrompt) {
          const promptEvent = installPrompt;
          installPrompt = null;
          promptEvent.prompt();
          if (promptEvent.userChoice && promptEvent.userChoice.catch) {
            promptEvent.userChoice.catch(function () { /* пользователь отказался */ });
          }
        } else {
          alert('Установка приложения:\n' +
            '• Chrome / Edge — значок установки в адресной строке.\n' +
            '• Android — меню браузера → «Добавить на главный экран».\n' +
            '• iPhone / iPad — «Поделиться» → «На экран „Домой“». ' +
            'Через file:// установка недоступна: откройте сайт по http/https ' +
            '(локальный сервер или хостинг).');
        }
        break;
        break;
      case 'about':
        alert('Калькулятор Металл Кровля\nРасчёт металлочерепицы, профлиста и металлосайдинга.\nРаскладка листов материала выполняется по геометрии ската.');
        break;
    }
  }

  function initMenus() {
    const menus = $$('.menu');
    menus.forEach(function (menu) {
      const trigger = menu.firstElementChild;
      trigger.addEventListener('click', function (ev) {
        ev.stopPropagation();
        const isOpen = menu.classList.contains('open');
        menus.forEach(function (m) { m.classList.remove('open'); });
        if (!isOpen) menu.classList.add('open');
      });
    });
    document.addEventListener('click', function () {
      menus.forEach(function (m) { m.classList.remove('open'); });
    });
    $$('.menu-dropdown [data-action]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        menus.forEach(function (m) { m.classList.remove('open'); });
        doAction(btn.getAttribute('data-action'));
      });
    });
  }

  function renderAll() {
    const calc = KP.calcProject(project);
    updateProjectFields();
    renderMaterials();
    if (canvasApi) canvasApi.render();
    renderDrawingElements();
    renderObjectsPanel();
    renderProps();
    renderStats(calc);
    renderLengths(calc);
    renderElements(calc);
    renderSummary(calc);
    renderSpecification(calc);
    const bottomDrawer = $('#bottomDrawer');
    if (bottomDrawer && !bottomDrawer.classList.contains('hidden') &&
        bottomDrawer.querySelector('.bottom-tabs .tab.active[data-tab="layouts"]')) {
      renderLayoutPages(calc);
    }
    renderTotals(calc);
    renderSheetTabs();
    renderToolbarFields();
    renderStatusInfo();
    renderUnderlayPanel();
    persist();
  }

  // Переворот координат контуров и вырезов между пользовательской
  // (Y вверх) и внутренней (Y вниз) системами. Операция симметричная.
  function flipProjectCoords(source) {
    const data = JSON.parse(JSON.stringify(source));
    (data.slopes || []).forEach(function (slope) {
      const pts = Array.isArray(slope.points) ? slope.points : [];
      if (!pts.length) return;
      const ys = pts.map(function (p) { return KP.num(p.y); });
      const maxY = Math.max.apply(null, ys);
      const flip = function (p) {
        return { x: Number(KP.num(p.x).toFixed(3)), y: Number((maxY - KP.num(p.y)).toFixed(3)) };
      };
      slope.points = pts.map(flip);
      (slope.cutouts || []).forEach(function (cut) {
        if (Array.isArray(cut.points)) cut.points = cut.points.map(flip);
      });
    });
    return data;
  }

  function downloadJson() {
    const data = flipProjectCoords(project);
    data.coords = 'y-up';
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'krovlya_' + (project.name || 'project').replace(/[\\/:*?"<>|]+/g, '-') + '.json';
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 2000);
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const parsed = JSON.parse(reader.result);
        const data = parsed && parsed.coords === 'y-up' ? flipProjectCoords(parsed) : parsed;
        if (data && typeof data === 'object') delete data.coords;
        project = KP.normalizeProject(data);
        selectedId = project.slopes.length ? project.slopes[0].id : null;
        selectedObjectId = null;
        activeMaterialId = (project.materials[0] || {}).id || null;
        activeType = (project.materials[0] || {}).type || 'tile';
        renderAll();
      } catch (e) {
        alert('Не удалось прочитать файл проекта.');
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  /* ---------- инициализация ---------- */

  function init() {
    fillElementCatalog();
    renderTemplatesMenu();
    initMenus();

    // PWA: офлайн-кеш и установка на устройство (работает на http/https,
    // при открытии через file:// регистрация просто пропускается).
    if ('serviceWorker' in navigator &&
        (location.protocol === 'http:' || location.protocol === 'https:')) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {
          /* без service worker приложение работает как раньше */
        });
      });
    }

    canvasApi = KP.createCanvas(canvasWrap, {
      getProject: function () { return project; },
      getSelected: function () { return selectedId; },
      getSelectedObject: function () { return selectedObjectId; },
      onSelect: function (id) {
        selectedId = id;
        selectedObjectId = null;
        renderAll();
      },
      onObjectSelect: function (id) {
        selectedObjectId = id;
        if (id) selectedId = null;
        renderAll();
      },
      onObjectDoubleClick: function (id) {
        selectedObjectId = id;
        if (id) selectedId = null;
        renderAll();
        const object = selectedDrawingObject();
        if (object) openObjectModal(object);
      },
      onChange: function () {
        renderAll();
      },
      onScaleChange: function () {
        updateZoomLabel();
      }
    });

    $('#projectName').addEventListener('input', function (ev) {
      project.name = ev.target.value;
      persist();
    });
    $('#projectCustomer').addEventListener('input', function (ev) {
      project.customer = ev.target.value;
      persist();
    });

    $('#btnTemplates').addEventListener('click', function (ev) {
      ev.stopPropagation();
      templatesMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', function (ev) {
      if (!ev.target.closest('.dropdown')) templatesMenu.classList.add('hidden');
    });

    $('#btnAddSlope').addEventListener('click', addSlope);
    $('#btnAddCutout').addEventListener('click', function () { openCutoutModal(); });
    $('#btnDeleteSelected').addEventListener('click', deleteCurrentSelection);
    $('#railDelete').addEventListener('click', deleteCurrentSelection);
    if ($('#btnLayoutDwgContours')) {
      $('#btnLayoutDwgContours').addEventListener('click', layoutDwgContours);
    }
    $('#btnInsertShape').addEventListener('click', function () { openCoordsModal(null); });
    $('#btnToolPolyline').addEventListener('click', function () { startPolygonDrawing('polyline'); });
    $('#btnToolLine').addEventListener('click', function () { startPolygonDrawing('line'); });
    $('#railCoords').addEventListener('click', function () { startPolygonDrawing('polyline'); });
    $('#railCoordsSlope').addEventListener('click', function () { openCoordsModal(null); });
    $('#railLine').addEventListener('click', function () { startPolygonDrawing('line'); });
    $('#railShape').addEventListener('click', function () { openShapeModal(null, 'dims'); });
    $('#btnToolSelect').addEventListener('click', setSelectTool);
    $('#railSelect').addEventListener('click', setSelectTool);

    $('#btnPolarApply').addEventListener('click', applyPolarFromInputs);
    ['polarLength', 'polarAngle'].forEach(function (id) {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        const length = KP.num($('#polarLength').value);
        if (length > 0) {
          ev.preventDefault();
          ev.stopPropagation();
          applyPolarFromInputs();
        }
        // Если длина не задана — Enter передаётся дальше и завершает фигуру.
      });
    });

    $$('.status-toggles [data-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        canvasApi.toggleDrawSetting(btn.getAttribute('data-toggle'));
        syncDrawToggles();
      });
    });
    const snapStepSelect = $('#snapStep');
    if (snapStepSelect) {
      snapStepSelect.addEventListener('change', function (ev) {
        canvasApi.setDrawSetting('snapStep', KP.num(ev.target.value));
        syncDrawToggles();
      });
    }
    const polarStepSelect = $('#polarStep');
    if (polarStepSelect) {
      polarStepSelect.addEventListener('change', function (ev) {
        canvasApi.setDrawSetting('polarStep', KP.num(ev.target.value));
        syncDrawToggles();
      });
    }
    window.addEventListener('keydown', function (ev) {
      const map = { F3: 'osnap', F8: 'ortho', F9: 'snap', F10: 'polar' };
      if (!map[ev.key]) return;
      ev.preventDefault();
      canvasApi.toggleDrawSetting(map[ev.key]);
      syncDrawToggles();
    });

    window.addEventListener('keydown', function (ev) {
      if (canvasApi && canvasApi.isDrawing()) return;
      const tag = String(ev.target && ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && (selectedObjectId || selectedId)) {
        ev.preventDefault();
        deleteCurrentSelection();
        return;
      }
      if (ev.key === 'Escape' && selectedObjectId) {
        selectedObjectId = null;
        renderAll();
        return;
      }
      if (!selectedObjectId) return;
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const dir = arrows[ev.key];
      if (!dir) return;
      ev.preventDefault();
      const object = selectedDrawingObject();
      if (!object) return;
      const step = ev.shiftKey ? 1 : (KP.num($('#snapStep').value) || 0.1);
      moveDrawingObject(object, dir[0] * step, dir[1] * step);
    });

    $('#btnMaterials').addEventListener('click', function () { toggleMaterials(true); });
    $('#railMaterials').addEventListener('click', function () { toggleMaterials(true); });
    $('#btnCloseMaterials').addEventListener('click', function () { toggleMaterials(false); });
    $('#btnAddMaterial').addEventListener('click', function () { openMaterialModal(null); });

    $('#btnAddElement').addEventListener('click', addElementFromForm);
    $('#btnAutoElements').addEventListener('click', autoElements);

    $('#btnExportXls').addEventListener('click', exportXls);
    $('#btnExportPdf').addEventListener('click', exportPdf);
    $('#btnExportPng').addEventListener('click', function () {
      const svg = canvasApi.getSvg();
      if (!svg) { alert('Нет скатов для выгрузки.'); return; }
      KP.exportCanvasPNG(svg, 'raskladka_' + KP.today().replace(/\./g, '-') + '.png');
    });
    $('#btnSaveJson').addEventListener('click', downloadJson);
    $('#fileImport').addEventListener('change', function (ev) {
      const file = ev.target.files && ev.target.files[0];
      if (file) importJson(file);
      ev.target.value = '';
    });
    $('#fileUnderlay').addEventListener('change', function (ev) {
      const file = ev.target.files && ev.target.files[0];
      if (file) insertImageUnderlay(file);
      ev.target.value = '';
    });
    $('#btnImportDwg').addEventListener('click', function () { $('#fileDwg').click(); });
    $('#fileDwg').addEventListener('change', function (ev) {
      const file = ev.target.files && ev.target.files[0];
      if (file) openDwgImportModal(file);
    });

    $('#btnToggleCalc').addEventListener('click', toggleBottom);
    if ($('#drawerResizer')) {
      $('#drawerResizer').addEventListener('pointerdown', startDrawerResize);
      $('#drawerResizer').addEventListener('dblclick', function () {
        applyBottomHeight(bottomTabName === 'layouts' ? window.innerHeight * 0.7 : 215);
        saveBottomUi();
      });
    }
    if ($('#btnPrintLayouts')) {
      $('#btnPrintLayouts').addEventListener('click', function () { exportPdf({ layoutOnly: true }); });
    }
    if ($('#btnPinBottom')) {
      $('#btnPinBottom').addEventListener('click', function () {
        bottomPinned = !bottomPinned;
        updatePinBottomButton();
        if (bottomPinned) setBottomTab(bottomTabName, true);
        saveBottomUi();
      });
    }
    $('#btnCloseBottom').addEventListener('click', function () {
      const drawer = $('#bottomDrawer');
      if (drawer) drawer.classList.add('hidden');
      bottomPinned = false;
      updatePinBottomButton();
      const toggle = $('#btnToggleCalc');
      if (toggle) toggle.classList.remove('active');
      saveBottomUi();
    });

    $('#tbLength').addEventListener('change', function (ev) {
      const slope = selectedSlope();
      if (!slope) return;
      const newHeight = Math.max(0.1, numericInput(ev.target.value));
      if (slope.shape === 'polygon' && Array.isArray(slope.points) && slope.points.length) {
        const k = newHeight / (KP.num(slope.height) || 1);
        slope.points = slope.points.map(function (p) {
          return { x: p.x, y: Number((p.y * k).toFixed(3)) };
        });
      }
      slope.height = newHeight;
      renderAll();
    });
    $('#tbZoom').addEventListener('change', function (ev) {
      const pct = KP.num(String(ev.target.value).replace('%', '').replace(',', '.'));
      if (pct > 0) canvasApi.setScale(pct / 100 * 48);
      updateZoomLabel();
    });
    $('#btnZoomIn').addEventListener('click', function () {
      canvasApi.setScale(canvasApi.getScale() * 1.25);
      updateZoomLabel();
    });
    $('#btnZoomOut').addEventListener('click', function () {
      canvasApi.setScale(canvasApi.getScale() / 1.25);
      updateZoomLabel();
    });

    $$('#bottomDrawer .bottom-tabs .tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        setBottomTab(tab.getAttribute('data-tab'), true);
      });
    });

    bindUnderlayPanel();
    renderAll();
    updateZoomLabel();
    syncDrawToggles();

    try {
      const savedUi = JSON.parse(localStorage.getItem(BOTTOM_UI_KEY) || '{}');
      bottomPinned = !!savedUi.pinned;
      bottomTabName = savedUi.tab || 'spec';
      updatePinBottomButton();
      if (Number.isFinite(Number(savedUi.height))) applyBottomHeight(savedUi.height);
      if (bottomPinned) setBottomTab(bottomTabName, true);
    } catch (e) { /* повреждённые настройки панели игнорируем */ }
  }

  function updateZoomLabel() {
    const input = $('#tbZoom');
    if (input && canvasApi) {
      input.value = Math.round(canvasApi.getScale() / 48 * 100) + '%';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
