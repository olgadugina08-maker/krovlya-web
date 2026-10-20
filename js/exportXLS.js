/* Выгрузка в Excel (формат XML Spreadsheet 2003, открывается .xls без зависимостей) */
(function () {
  const KP = window.KP;

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cell(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return '<Cell><Data ss:Type="Number">' + value.toFixed(6) + '</Data></Cell>';
    }
    return '<Cell><Data ss:Type="String">' + esc(value) + '</Data></Cell>';
  }

  function row(values, isHeader) {
    const style = isHeader ? ' ss:StyleID="sHead"' : '';
    return '<Row>' + values.map(function (v) {
      const c = cell(v);
      return style ? c.replace('<Cell>', '<Cell' + style + '>') : c;
    }).join('') + '</Row>';
  }

  function sheet(name, rows, widths) {
    const cols = widths && widths.length
      ? '<Columns>' + widths.map(function (w) { return '<Column ss:Width="' + w + '"/>'; }).join('') + '</Columns>'
      : '';
    return '<Worksheet ss:Name="' + esc(name) + '"><Table>' + cols + rows.join('') + '</Table></Worksheet>';
  }

  function sanitizeFilename(name) {
    return String(name || 'raschet')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '_')
      .slice(0, 80);
  }

  KP.exportXLS = function (project, calc) {
    const rows = calc.rows;
    const totals = calc.totals;

    const slopeRows = [
      row(['№', 'Скат', 'Форма', 'Ширина, м', 'Длина, м', 'Материал', 'Площадь ската, м²',
        'Полная площадь листов, м²', 'Полезная площадь листов, м²', 'Отходы, %', 'Листов, шт'], true)
    ];
    rows.forEach(function (r, index) {
      slopeRows.push(row([
        index + 1,
        r.slope.name,
        KP.shapeLabel(r.slope.shape),
        KP.num(r.slope.width),
        KP.num(r.slope.height),
        r.material.name,
        r.slopeArea,
        r.fullArea,
        r.usefulArea,
        r.waste,
        r.sheetCount
      ]));
    });
    slopeRows.push(row([
      '', 'ИТОГО', '', '', '', '',
      totals.area, totals.fullArea, totals.usefulArea, totals.waste, totals.sheets
    ], true));

    const lengthRows = [
      row(['Скат', 'Материал', 'Длина листа, м', 'Кол-во, шт', 'Полная площадь, м²', 'Полезная площадь, м²'], true)
    ];
    rows.forEach(function (r) {
      r.list.forEach(function (item) {
        lengthRows.push(row([
          r.slope.name,
          r.material.name,
          item.length,
          item.count,
          item.length * r.fullWidth * item.count,
          item.length * r.usefulWidth * item.count
        ]));
      });
    });

    const elementRows = [
      row(['№', 'Доборный элемент', 'Ед.', 'Кол-во', 'Цена, ₽', 'Сумма, ₽'], true)
    ];
    project.elements.forEach(function (el, index) {
      elementRows.push(row([
        index + 1,
        el.name,
        el.unit || 'м',
        KP.num(el.qty),
        KP.num(el.price),
        KP.num(el.qty) * KP.num(el.price)
      ]));
    });
    elementRows.push(row(['', 'ИТОГО', '', '', '', totals.elementCost], true));

    const summaryRows = [
      row(['Материал', 'Тип', 'Скатов', 'Листов, шт', 'Полная площадь, м²',
        'Полезная площадь, м²', 'Стоимость, ₽'], true)
    ];
    calc.usage.forEach(function (u) {
      summaryRows.push(row([
        u.material.name,
        (KP.TYPES[u.material.type] || {}).label || u.material.type,
        u.slopes,
        u.sheets,
        u.fullArea,
        u.usefulArea,
        u.cost
      ]));
    });

    const totalRows = [
      row(['Показатель', 'Значение'], true),
      row(['Проект', project.name || '']),
      row(['Заказчик', project.customer || '']),
      row(['Дата', project.date || KP.today()]),
      row(['Площадь скатов, м²', totals.area]),
      row(['Полная площадь листов, м²', totals.fullArea]),
      row(['Полезная площадь листов, м²', totals.usefulArea]),
      row(['Процент отходов, %', totals.waste]),
      row(['Листов, шт', totals.sheets]),
      row(['Стоимость материалов, ₽', totals.materialCost]),
      row(['Стоимость доборных элементов, ₽', totals.elementCost]),
      row(['ИТОГО, ₽', totals.total], true)
    ];

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<?mso-application progid="Excel.Sheet"?>\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
        'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" ' +
        'xmlns:x="urn:schemas-microsoft-com:office:excel">' +
        '<Styles>' +
          '<Style ss:ID="sHead"><Font ss:Bold="1"/><Interior ss:Color="#E8F0FE" ss:Pattern="Solid"/></Style>' +
        '</Styles>' +
        sheet('Скаты', slopeRows, [30, 120, 100, 70, 70, 160, 90, 110, 110, 60, 60]) +
        sheet('Список длин', lengthRows, [120, 160, 90, 60, 100, 100]) +
        sheet('Доборные', elementRows, [30, 200, 50, 70, 80, 90]) +
        sheet('Сводка по материалам', summaryRows, [200, 110, 60, 70, 100, 100, 100]) +
        sheet('Итого', totalRows, [260, 140]) +
      '</Workbook>';

    const blob = new Blob(['\ufeff' + xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = sanitizeFilename('raschet_' + (project.name || 'proekt') + '_' + KP.today()) + '.xls';
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 3000);
  };
})();
