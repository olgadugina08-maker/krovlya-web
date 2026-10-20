/* Печать / сохранение в PDF через встроенный диалог браузера */
(function () {
  const KP = window.KP;

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function table(headers, rows) {
    return '<table><thead><tr>' + headers.map(function (h) {
      return '<th>' + esc(h) + '</th>';
    }).join('') + '</tr></thead><tbody>' + rows.map(function (r) {
      return '<tr>' + r.map(function (c, i) {
        return '<td' + (i === 0 ? ' style="text-align:left"' : '') + '>' + esc(c) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table>';
  }

  function slopeSvgForPrint(sourceSvg, slopeId, padding) {
    const clone = sourceSvg.cloneNode(true);
    let target = null;
    clone.querySelectorAll('g[data-slope]').forEach(function (group) {
      if (!target && group.getAttribute('data-slope') === slopeId) target = group;
    });
    if (!target) return null;

    const defs = clone.querySelector('defs');
    Array.prototype.slice.call(clone.children).forEach(function (child) {
      if (child !== defs && child !== target) clone.removeChild(child);
    });

    // Печать всегда ориентирует листы вертикально: убираем поворот ската.
    Array.prototype.slice.call(target.children).forEach(function (child) {
      if (child.tagName && child.tagName.toLowerCase() === 'g' && child.hasAttribute('transform')) {
        child.removeAttribute('transform');
      }
    });
    // На печатной странице название и материал уже есть в шапке и параметрах.
    target.querySelectorAll('[data-slope-label]').forEach(function (label) {
      if (label.parentNode) label.parentNode.removeChild(label);
    });
    // Стрелка направления на печати не нужна — направление указано в параметрах.
    target.querySelectorAll('[data-slope-arrow]').forEach(function (arrow) {
      if (arrow.parentNode) arrow.parentNode.removeChild(arrow);
    });

    const polygon = target.querySelector('polygon');
    if (!polygon) return null;
    const points = (polygon.getAttribute('points') || '').trim().split(/\s+/).map(function (pair) {
      const xy = pair.split(',');
      return { x: Number(xy[0]), y: Number(xy[1]) };
    }).filter(function (p) {
      return Number.isFinite(p.x) && Number.isFinite(p.y);
    });
    if (!points.length) return null;

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

    const pad = padding == null ? 1.6 : padding;
    const vbX = minX - pad;
    const vbY = minY - pad;
    const vbW = (maxX - minX) + pad * 2;
    const vbH = (maxY - minY) + pad * 2;
    clone.setAttribute('viewBox', vbX.toFixed(4) + ' ' + vbY.toFixed(4) + ' ' +
      vbW.toFixed(4) + ' ' + vbH.toFixed(4));
    clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    clone.removeAttribute('style');

    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', vbX.toFixed(4));
    bg.setAttribute('y', vbY.toFixed(4));
    bg.setAttribute('width', vbW.toFixed(4));
    bg.setAttribute('height', vbH.toFixed(4));
    bg.setAttribute('fill', '#ffffff');
    clone.insertBefore(bg, target);

    return { svg: clone, drawW: vbW, drawH: vbH };
  }

  function layoutDirectionLabel(slope) {
    if (slope.layoutMode === 'manual') {
      const angle = Number(slope.layoutAngle);
      return 'Вручную' + (Number.isFinite(angle) ? ' (' + KP.fmt(angle, 0) + '°)' : '');
    }
    const startRight = (slope.layoutStart === 'right') !== !!slope.layoutMirror;
    return startRight ? 'Справа налево' : 'Слева направо';
  }

  function slopeLengthsHtml(items) {
    if (!items || !items.length) return '<p class="pr-empty">—</p>';
    const half = Math.ceil(items.length / 2);
    const groups = [items.slice(0, half), items.slice(half)].filter(function (group) {
      return group.length;
    });
    return '<div class="pr-lengths-grid">' + groups.map(function (group, groupIndex) {
      return '<table class="pr-lengths-table"><thead><tr><th>№</th><th>Длина</th><th>Шт.</th></tr></thead><tbody>' +
        group.map(function (item, index) {
          return '<tr><td>' + (groupIndex * half + index + 1) + '</td><td>' +
            KP.fmt(item.length) + '</td><td>' + item.count + '</td></tr>';
        }).join('') + '</tbody></table>';
    }).join('') + '</div>';
  }

  function buildSlopePages(svg, rows, project) {
    if (!svg) return '';
    const records = [];
    rows.forEach(function (row, index) {
      const record = slopeSvgForPrint(svg, row.slope.id);
      if (record) records.push({ row: row, index: index, svg: record.svg, drawW: record.drawW, drawH: record.drawH });
    });
    if (!records.length) return '';

    let maxW = 0;
    let maxH = 0;
    records.forEach(function (record) {
      maxW = Math.max(maxW, record.drawW);
      maxH = Math.max(maxH, record.drawH);
    });
    // Одинаковый масштаб для всех страниц: A4 книжная, схема — до 186 × 178 мм.
    const mmPerMeter = Math.min(186 / Math.max(0.1, maxW), 178 / Math.max(0.1, maxH), 60);

    return records.map(function (record) {
      const widthMm = Math.max(20, record.drawW * mmPerMeter);
      const heightMm = Math.max(20, record.drawH * mmPerMeter);
      record.svg.setAttribute('width', widthMm.toFixed(1) + 'mm');
      record.svg.setAttribute('height', heightMm.toFixed(1) + 'mm');
      record.svg.setAttribute('style', 'width:' + widthMm.toFixed(1) + 'mm;height:' +
        heightMm.toFixed(1) + 'mm;max-width:100%');
      const slope = record.row.slope;
      const material = record.row.material;
      const rounding = KP.num(material.roundingMm) > 0
        ? KP.num(material.roundingMm) / 1000
        : KP.num(slope.rounding);
      const eaveOverhangMm = KP.num(slope.eaveOverhang) || KP.num(material.eaveOverhang);
      const params = [
        ['Продукция', material.name],
        ['Расчет №', String(project.number || project.id || '—') + ' от ' + String(project.date || KP.today())],
        ['Длина ската, м', KP.fmt(slope.height)],
        ['Площадь ската / фигуры, м²', KP.fmt(record.row.slopeArea) + ' / ' + KP.fmt(record.row.figureArea)],
        ['Площадь листов полезная / полная, м²', KP.fmt(record.row.usefulArea) + ' / ' + KP.fmt(record.row.fullArea)],
        ['Процент отходов, %', KP.fmt(record.row.waste)],
        ['Направление раскладки', layoutDirectionLabel(slope)],
        ['Ширина листа полезная / общая, м', KP.fmt(material.usefulWidth, 3) + ' / ' + KP.fmt(material.fullWidth, 3)],
        ['Шаг волны, мм', KP.fmt(KP.num(material.waveStep) * 1000, 0)],
        ['Перекрытие замковое, м', KP.fmt(KP.num(material.lockOverlap) / 1000, 2)],
        ['Округление, м', KP.fmt(rounding, 2)],
        ['Смещение гориз. / верт., м', KP.fmt(KP.num(slope.offsetX), 2) + ' / ' + KP.fmt(KP.num(slope.offsetY), 2)],
        ['Карнизный свес, м', KP.fmt(eaveOverhangMm / 1000, 2)]
      ];
      return '<section class="pr-sheet">' +
        '<h2>' + esc(slope.name) + '</h2>' +
        '<div class="pr-sheet-top">' +
          '<div class="pr-lengths"><h4>Список длин</h4>' + slopeLengthsHtml(record.row.list) + '</div>' +
          '<table class="pr-params"><tbody>' + params.map(function (pair) {
            return '<tr><th>' + esc(pair[0]) + '</th><td>' + esc(pair[1]) + '</td></tr>';
          }).join('') + '</tbody></table>' +
        '</div>' +
        '<div class="pr-canvas pr-canvas-sheet">' +
          new XMLSerializer().serializeToString(record.svg) +
        '</div>' +
      '</section>';
    }).join('');
  }

  KP.buildLayoutPages = function (svg, calc, project) {
    return buildSlopePages(svg, calc.rows, project);
  };

  KP.exportPDF = function (project, calc, svg, options) {
    const report = document.getElementById('printReport');
    const rows = calc.rows;
    const totals = calc.totals;

    const slopePagesHtml = buildSlopePages(svg, rows, project);
    if (options && options.layoutOnly) {
      report.innerHTML = slopePagesHtml || '<p>Нет скатов для печати раскладки.</p>';
      setTimeout(function () { window.print(); }, 120);
      return;
    }

    const firstMaterial = (calc.usage[0] || {}).material || {};
    const calcTypes = Array.from(new Set(calc.usage.map(function (u) {
      return u.material.calcType || (KP.TYPES[u.material.type] && KP.TYPES[u.material.type].label) || '';
    }).filter(Boolean)));
    const sameMaterialNumber = function (key) {
      return calc.usage.every(function (u) {
        return Math.abs(KP.num(u.material[key]) - KP.num(firstMaterial[key])) < 1e-9;
      });
    };
    const widthValue = calc.usage.length && sameMaterialNumber('usefulWidth') && sameMaterialNumber('fullWidth')
      ? KP.fmt(firstMaterial.usefulWidth, 3) + ' / ' + KP.fmt(firstMaterial.fullWidth, 3)
      : 'по материалам';
    const overlapValue = calc.usage.length && sameMaterialNumber('lockOverlap')
      ? KP.fmt(KP.num(firstMaterial.lockOverlap) / 1000, 2)
      : 'по материалам';
    const roundingValue = calc.usage.length && sameMaterialNumber('roundingMm')
      ? KP.fmt(KP.num(firstMaterial.roundingMm) / 1000, 2)
      : 'по материалам';
    const eaveOverhangValue = calc.usage.length && sameMaterialNumber('eaveOverhang')
      ? KP.fmt(KP.num(firstMaterial.eaveOverhang) / 1000, 2)
      : 'по материалам';
    const waveStepValue = calc.usage.length && sameMaterialNumber('waveStep')
      ? KP.fmt(KP.num(firstMaterial.waveStep) * 1000, 0)
      : 'по материалам';
    const parameterRows = [
      ['Расчёт №', String(project.number || project.id || '—') + ' от ' + String(project.date || KP.today())],
      ['Вид расчёта', calcTypes.length ? calcTypes.join('; ') : '—'],
      ['Площадка', project.name || '—'],
      ['Ширина листа полезная / общая, м', widthValue],
      ['Шаг волны, мм', waveStepValue],
      ['Перекрытие замковое, м', overlapValue],
      ['Округление, м', roundingValue],
      ['Карнизный свес, м', eaveOverhangValue]
    ];

    const slopeRows = rows.map(function (r, index) {
      return [
        index + 1,
        KP.fmt(r.slope.height),
        KP.fmt(r.slopeArea),
        KP.fmt(r.figureArea),
        KP.fmt(r.fullArea),
        KP.fmt(r.usefulArea),
        KP.fmt(r.waste)
      ];
    });
    slopeRows.push(['Итог',
      KP.fmt(rows.reduce(function (sum, r) { return sum + KP.num(r.slope.height); }, 0)),
      KP.fmt(totals.area), KP.fmt(totals.area), KP.fmt(totals.fullArea),
      KP.fmt(totals.usefulArea), KP.fmt(totals.waste)]);

    const lengthMap = new Map();
    rows.forEach(function (r) {
      r.list.forEach(function (item) {
        const key = Number(item.length).toFixed(3);
        if (!lengthMap.has(key)) lengthMap.set(key, { length: Number(item.length), count: 0 });
        lengthMap.get(key).count += item.count;
      });
    });
    const lengthRows = Array.from(lengthMap.values()).sort(function (a, b) {
      return a.length - b.length;
    }).map(function (item, index) {
      return [index + 1, KP.fmt(item.length), String(item.count)];
    });
    const lengthsHtml = lengthRows.length
      ? '<h2>Список длин</h2>' + table(['№', 'Длина, м', 'Кол-во, шт'], lengthRows)
      : '';

    const elementRows = project.elements.map(function (el, index) {
      return [
        index + 1,
        el.name,
        el.unit || 'м',
        KP.fmt(el.qty),
        KP.fmt(el.price, 0),
        KP.fmt(KP.num(el.qty) * KP.num(el.price), 0)
      ];
    });
    if (elementRows.length) {
      elementRows.push(['', 'ИТОГО', '', '', '', KP.fmt(totals.elementCost, 0)]);
    }

    const summaryRows = calc.usage.map(function (u) {
      return [u.material.name, String(u.slopes), String(u.sheets), KP.fmt(u.fullArea),
        KP.fmt(u.usefulArea), KP.fmt(u.cost, 0)];
    });

    report.innerHTML =
      '<h1>Расчёт кровли — ' + esc(project.name || 'без названия') + '</h1>' +
      '<div class="pr-head">' +
        '<div class="pr-meta">Заказчик: ' + esc(project.customer || '—') + '<br>' +
        'Дата: ' + esc(project.date || KP.today()) + '</div>' +
        '<div class="pr-meta">Площадь скатов: <b>' + KP.fmt(totals.area) + ' м²</b><br>' +
        'Полная площадь листов: <b>' + KP.fmt(totals.fullArea) + ' м²</b><br>' +
        'Отходы: <b>' + KP.fmt(totals.waste) + ' %</b></div>' +
      '</div>' +
      '<h2>Параметры расчёта</h2>' +
      table(['Параметр', 'Значение'], parameterRows) +
      '<h2>Параметры скатов</h2>' +
      table(['№', 'H ската, м', 'S ската, м²', 'S фигуры, м²', 'S полная листов, м²',
        'S полезн. листов, м²', '% отходов'], slopeRows) +
      lengthsHtml +
      (elementRows.length ? '<h2>Доборные элементы</h2>' +
        table(['№', 'Наименование', 'Ед.', 'Кол-во', 'Цена, ₽', 'Сумма, ₽'], elementRows) : '') +
      (summaryRows.length ? '<h2>Сводка по материалам</h2>' +
        table(['Материал', 'Скатов', 'Листов, шт', 'Полная площадь, м²', 'Полезная площадь, м²', 'Стоимость, ₽'], summaryRows) : '') +
      '<h2>Итого</h2>' +
      table(['Показатель', 'Значение'], [
        ['Стоимость материалов, ₽', KP.fmt(totals.materialCost, 0)],
        ['Стоимость доборных элементов, ₽', KP.fmt(totals.elementCost, 0)],
        ['ИТОГО, ₽', KP.fmt(totals.total, 0)]
      ]) +
      slopePagesHtml +
      '<div class="pr-foot">Сформировано в «Калькулятор Металл Кровля» ' + esc(KP.today()) + '.</div>';

    setTimeout(function () {
      window.print();
    }, 120);
  };
})();
