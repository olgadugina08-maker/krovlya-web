/* Холст: отрисовка скатов и раскладка листов (SVG) */
(function () {
  const KP = window.KP;
  const MIN_SCALE = 1;

  const EDGE_STYLES = {
    eave: { color: '#d7202a', width: 0.075, dash: '' },
    ridge: { color: '#2f6f9f', width: 0.075, dash: '' },
    valley: { color: '#7a4dad', width: 0.065, dash: '0.18 0.1' },
    end: { color: '#c98a00', width: 0.065, dash: '0.18 0.1' }
  };

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Локальные координаты ската — X вправо, Y вверх; экран (SVG) — Y вниз,
  // поэтому при выводе ордината переворачивается относительно высоты ската.
  function pointsOf(layout) {
    const local = KP.slopePoints(layout.slope);
    return local.map(function (p) {
      return [layout.x + p[0], layout.y + (layout.h - p[1])];
    });
  }

  function worldPointsOf(layout) {
    const points = pointsOf(layout);
    const slope = layout.slope;
    if (!slope.rotation || !slope.renderOrigin) return points;
    const angle = slope.rotation * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const origin = slope.renderOrigin;
    return points.map(function (p) {
      const dx = p[0] - origin.x;
      const dy = p[1] - origin.y;
      return [
        origin.x + dx * cos - dy * sin,
        origin.y + dx * sin + dy * cos
      ];
    });
  }

  function pointsAttr(points) {
    return points.map(function (p) { return p[0].toFixed(4) + ',' + p[1].toFixed(4); }).join(' ');
  }

  function pathFromPoints(points) {
    if (!points || !points.length) return '';
    return 'M' + points.map(function (p) {
      return p[0].toFixed(4) + ' ' + p[1].toFixed(4);
    }).join(' L') + ' Z';
  }

  // Контур ската с отверстиями вырезов. clip-rule="evenodd" вырезает
  // внутренние контуры, поэтому листы в вырез не попадают.
  function clipPathDataOf(layout) {
    let d = pathFromPoints(pointsOf(layout));
    const cutouts = Array.isArray(layout.slope.cutouts) ? layout.slope.cutouts : [];
    cutouts.forEach(function (cut) {
      if (!cut || !Array.isArray(cut.points) || cut.points.length < 3) return;
      if (KP.polygonArea(cut.points) <= 1e-6) return;
      const pts = cut.points.map(function (p) {
        return [layout.x + KP.num(p.x), layout.y + (layout.h - KP.num(p.y))];
      });
      d += ' ' + pathFromPoints(pts);
    });
    return d;
  }

  // Интервалы по X, где нижняя кромка является карнизом.
  // Важно: свес строится только по горизонтальным нижним кромкам; боковые
  // наклонные рёбра не должны давать диагональный «свес». На вырезах — разрыв.
  function eaveXIntervals(slope, width) {
    const limit = Math.max(0, KP.num(width));
    // Ось Y направлена вверх: карниз простых фигур лежит при y = 0.
    if (slope.shape !== 'polygon') return [{ from: 0, to: limit, y: 0 }];
    const points = KP.slopePoints(slope);
    if (points.length < 2) return [];
    const types = Array.isArray(slope.edgeTypes) ? slope.edgeTypes : [];
    const ys = points.map(function (point) { return KP.num(point[1]); });
    const maxY = Math.max.apply(null, ys);
    const minY = Math.min.apply(null, ys);
    const midY = minY + (maxY - minY) / 2;
    const intervals = [];
    // Сначала — горизонтальные нижние кромки. Вертикальные и наклонные боковые
    // рёбра не должны давать диагональный «свес».
    points.forEach(function (a, index) {
      const b = points[(index + 1) % points.length];
      const ax = KP.num(a[0]);
      const ay = KP.num(a[1]);
      const bx = KP.num(b[0]);
      const by = KP.num(b[1]);
      const from = Math.max(0, Math.min(ax, bx));
      const to = Math.min(limit, Math.max(ax, bx));
      if (to - from <= 1e-6) return;
      const isHorizontal = Math.abs(by - ay) <= Math.max(0.04, Math.abs(bx - ax) * 0.12);
      // Ось Y направлена вверх, поэтому нижняя кромка — та, у которой меньше y.
      const isLower = Math.max(ay, by) <= midY;
      if (isHorizontal && isLower) intervals.push({ from: from, to: to, y: (ay + by) / 2 });
    });
    if (!intervals.length) {
      points.forEach(function (a, index) {
        const b = points[(index + 1) % points.length];
        if (types[index] !== 'eave' && slope.eaveEdge !== index) return;
        const from = Math.max(0, Math.min(KP.num(a[0]), KP.num(b[0])));
        const to = Math.min(limit, Math.max(KP.num(a[0]), KP.num(b[0])));
        if (to - from > 1e-6) intervals.push({ from: from, to: to, y: null });
      });
    }
    intervals.sort(function (a, b) { return a.from - b.from; });
    const merged = [];
    intervals.forEach(function (interval) {
      const last = merged[merged.length - 1];
      const sameLevel = last && (last.y == null
        ? interval.y == null
        : interval.y != null && Math.abs(last.y - interval.y) < 1e-6);
      if (sameLevel && interval.from <= last.to + 1e-6) {
        last.to = Math.max(last.to, interval.to);
      } else {
        merged.push({ from: interval.from, to: interval.to, y: interval.y });
      }
    });
    return merged;
  }


  function objectBoundsOf(objects) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = function (x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };

    (objects || []).forEach(function (obj) {
      if (!obj) return;
      if (obj.kind === 'circle') {
        const cx = Number(obj.cx) || 0;
        const cy = Number(obj.cy) || 0;
        const r = Math.max(0, Number(obj.r) || 0);
        add(cx - r, cy - r);
        add(cx + r, cy + r);
      } else if (obj.kind === 'text') {
        const x = Number(obj.x) || 0;
        const y = Number(obj.y) || 0;
        const h = Math.max(0.05, Number(obj.height) || 0.2);
        add(x, y - h);
        add(x + Math.max(1, String(obj.text || '').length) * h * 0.62, y + h * 0.3);
      } else if (Array.isArray(obj.points)) {
        obj.points.forEach(function (p) { add(Number(p.x) || 0, Number(p.y) || 0); });
      }
    });

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  function objectMarkup(obj, selected) {
    if (!obj || !obj.id) return '';
    const stroke = selected ? '#d7202a' : (obj.color || '#2f6f9f');
    const width = selected ? 2.2 : 1.2;
    const common = 'fill="none" stroke="' + stroke + '" stroke-width="' + width +
      '" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"';
    let html = '<g data-object="' + esc(obj.id) + '" style="cursor:move">';

    if (obj.kind === 'circle') {
      const cx = Number(obj.cx) || 0;
      const cy = Number(obj.cy) || 0;
      const r = Math.max(0, Number(obj.r) || 0);
      html += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" ' +
        'stroke="rgba(0,0,0,0.001)" stroke-width="10" vector-effect="non-scaling-stroke" pointer-events="stroke"/>';
      html += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" ' + common + '/>';
      if (selected) {
        html += '<circle cx="' + cx + '" cy="' + cy + '" r="0.14" fill="#ffffff" stroke="#d7202a" ' +
          'stroke-width="0.03"/>';
      }
    } else if (obj.kind === 'text') {
      const text = esc(obj.text || '');
      const height = Math.max(0.05, Number(obj.height) || 0.2);
      const rotation = Number(obj.rotation) || 0;
      const transform = Math.abs(rotation) > 1e-6
        ? ' transform="rotate(' + rotation + ' ' + obj.x + ' ' + obj.y + ')"'
        : '';
      html += '<text x="' + obj.x + '" y="' + obj.y + '" font-size="' + height + '" fill="' +
        stroke + '" font-family="Geologica, Segoe UI, Arial, sans-serif"' + transform + '>' + text + '</text>';
    } else if (Array.isArray(obj.points) && obj.points.length >= 2) {
      const points = obj.points.map(function (p) { return p.x + ',' + p.y; }).join(' ');
      const closed = !!obj.closed && obj.points.length >= 3;
      html += (closed
        ? '<polygon points="' + points + '" fill="none" stroke="rgba(0,0,0,0.001)" stroke-width="10" vector-effect="non-scaling-stroke" pointer-events="stroke"/>'
        : '<polyline points="' + points + '" fill="none" stroke="rgba(0,0,0,0.001)" stroke-width="10" vector-effect="non-scaling-stroke" pointer-events="stroke"/>');
      html += closed
        ? '<polygon points="' + points + '" ' + common + '/>'
        : '<polyline points="' + points + '" ' + common + '/>';
      if (selected) {
        obj.points.forEach(function (p) {
          html += '<circle cx="' + p.x + '" cy="' + p.y + '" r="0.12" fill="#ffffff" ' +
            'stroke="#d7202a" stroke-width="0.03"/>';
        });
      }
    }

    html += '</g>';
    return html;
  }

  KP.createCanvas = function (container, options) {
    let scale = 60;
    let svgEl = null;
    let layoutMap = {};
    let drag = null;
    let objectDrag = null;
    let slopeDrag = null;
    let drawState = null;
    let directionPick = null;
    let panState = null;

    const drawSettings = {
      snap: true,
      snapStep: 0.1,
      osnap: true,
      ortho: false,
      polar: false,
      polarStep: 15,
      showGrid: true,
      showDimensions: true
    };

    const canvasArea = container.closest('.canvas-area') || container;
    document.addEventListener('wheel', function (ev) {
      if (!canvasArea.contains(ev.target)) return;
      const tag = String(ev.target && ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button') return;
      onWheel(ev);
    }, { passive: false, capture: true });

    // Панорамирование средней кнопкой мыши (нажатым «скроллом») по всей
    // области холста, включая пустой фон вне SVG.
    container.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 1) return;
      startPan(ev);
    });
    container.addEventListener('mousedown', function (ev) {
      if (ev.button === 1) ev.preventDefault();
    });
    container.addEventListener('auxclick', function (ev) {
      if (ev.button === 1) ev.preventDefault();
    });

    function toSvg(ev) {
      if (!svgEl) return { x: 0, y: 0 };
      const pt = svgEl.createSVGPoint();
      pt.x = ev.clientX;
      pt.y = ev.clientY;
      const ctm = svgEl.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const p = pt.matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    }

    function svgToScreen(point) {
      if (!svgEl || !point) return null;
      const ctm = svgEl.getScreenCTM();
      if (!ctm) return null;
      const pt = svgEl.createSVGPoint();
      pt.x = point.x;
      pt.y = point.y;
      const p = pt.matrixTransform(ctm);
      return { x: p.x, y: p.y };
    }

    function render() {
      const project = options.getProject();
      const selectedId = options.getSelected();
      const selectedObjectId = options.getSelectedObject ? options.getSelectedObject() : null;
      const objects = Array.isArray(project.objects) ? project.objects : [];

      const underlay = project.underlay && project.underlay.visible ? project.underlay : null;

      if (!project.slopes.length && !underlay && !objects.length) {
        if (drawState) {
          ensureSvgForDraw();
          updateDrawLayer();
          return;
        }
        container.innerHTML =
          '<div class="empty-state"><strong>Пока нет скатов</strong>' +
          'Добавьте скат кнопкой «+ Скат», выберите шаблон или начертите фигуру мышью.</div>';
        svgEl = null;
        return;
      }

      const gap = 2.2;
      let cursor = 0;
      let maxH = 0;
      let totalW = 0;
      layoutMap = {};

      const layouts = project.slopes.map(function (slope) {
        const w = Math.max(0.2, KP.num(slope.width));
        const h = Math.max(0.2, KP.num(slope.height));
        const tw = slope.shape === 'trapezoid'
          ? Math.max(0, Math.min(KP.num(slope.topWidth), w))
          : (slope.shape === 'triangle' ? 0 : w);
        const inPlace = !!slope.inPlace && slope.anchor &&
          Number.isFinite(Number(slope.anchor.x)) && Number.isFinite(Number(slope.anchor.y));
        const offset = slope.dragOffset || {};
        const offsetX = Number.isFinite(Number(offset.x)) ? Number(offset.x) : 0;
        const offsetY = Number.isFinite(Number(offset.y)) ? Number(offset.y) : 0;
        const x = (inPlace ? Number(slope.anchor.x) : cursor) + offsetX;
        const y = (inPlace ? Number(slope.anchor.y) : 0) + offsetY;
        const layout = { slope: slope, x: x, y: y, w: w, h: h, tw: tw, shape: slope.shape, inPlace: inPlace };
        layoutMap[slope.id] = layout;
        if (!inPlace) {
          cursor += w + gap;
          totalW = Math.max(totalW, cursor - gap);
          maxH = Math.max(maxH, h);
        }
        return layout;
      });

      const padLeft = 1.5;
      const padRight = 1.0;
      const padTop = 2.1;
      const padBottom = 3.9;

      const ux = underlay ? KP.num(underlay.x) : 0;
      const uy = underlay ? KP.num(underlay.y) : 0;
      const uw = underlay ? Math.max(0.1, KP.num(underlay.width)) : 0;
      const uh = underlay ? Math.max(0.1, KP.num(underlay.height)) : 0;

      let minX = 0;
      let minY = 0;
      let maxX = totalW;
      let maxY = maxH;
      layouts.forEach(function (lay) {
        if (lay.slope.rotation && lay.slope.renderOrigin) {
          worldPointsOf(lay).forEach(function (p) {
            minX = Math.min(minX, p[0]);
            minY = Math.min(minY, p[1]);
            maxX = Math.max(maxX, p[0]);
            maxY = Math.max(maxY, p[1]);
          });
        } else {
          minX = Math.min(minX, lay.x);
          minY = Math.min(minY, lay.y);
          maxX = Math.max(maxX, lay.x + lay.w);
          maxY = Math.max(maxY, lay.y + lay.h);
        }
      });
      if (underlay) {
        minX = Math.min(minX, ux);
        minY = Math.min(minY, uy);
        maxX = Math.max(maxX, ux + uw);
        maxY = Math.max(maxY, uy + uh);
      }
      const objectBounds = objectBoundsOf(objects);
      if (objectBounds) {
        minX = Math.min(minX, objectBounds.minX);
        minY = Math.min(minY, objectBounds.minY);
        maxX = Math.max(maxX, objectBounds.maxX);
        maxY = Math.max(maxY, objectBounds.maxY);
      }

      let vbW = (maxX - minX) + padLeft + padRight;
      let vbH = (maxY - minY) + padTop + padBottom;
      let vbX = minX - padLeft;
      let vbY = minY - padTop;
      // Рабочее поле должно занимать всю видимую область холста,
      // даже если скаты нарисованы только в верхней части.
      const visibleW = Math.max(320, container.clientWidth - 28);
      const visibleH = Math.max(240, container.clientHeight - 28);
      const fillW = Math.max(vbW, visibleW / scale);
      const fillH = Math.max(vbH, visibleH / scale);
      if (fillW > vbW) {
        vbX -= (fillW - vbW) / 2;
        vbW = fillW;
      }
      if (fillH > vbH) {
        vbY -= (fillH - vbH) / 2;
        vbH = fillH;
      }
      const pixelW = Math.round(vbW * scale);
      const pixelH = Math.round(vbH * scale);

      if (!svgEl) {
        svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        container.innerHTML = '';
        container.appendChild(svgEl);
        bindEvents();
      }

      svgEl.setAttribute('viewBox', vbX + ' ' + vbY + ' ' + vbW + ' ' + vbH);
      svgEl.setAttribute('width', pixelW);
      svgEl.setAttribute('height', pixelH);
      svgEl.style.width = pixelW + 'px';
      svgEl.style.height = pixelH + 'px';

      const defs =
        '<defs>' +
          '<pattern id="kp-grid" width="1" height="1" patternUnits="userSpaceOnUse">' +
            '<path d="M 1 0 L 0 0 0 1" fill="none" stroke="#ececec" stroke-width="0.018"/>' +
          '</pattern>' +
          layouts.map(function (lay) {
            return '<clipPath id="kp-clip-' + esc(lay.slope.id) + '">' +
              '<path d="' + clipPathDataOf(lay) + '" clip-rule="evenodd"/></clipPath>';
          }).join('') +
        '</defs>';

      let body = '';
      body += '<rect x="' + vbX + '" y="' + vbY + '" width="' + vbW + '" height="' + vbH +
              '" fill="#ffffff"/>';
      if (drawSettings.showGrid) {
        body += '<rect x="' + vbX + '" y="' + vbY + '" width="' + vbW + '" height="' + vbH +
                '" fill="url(#kp-grid)"/>';
      }
      if (underlay) {
        body += '<image href="' + esc(underlay.dataUrl) + '" x="' + ux + '" y="' + uy +
                '" width="' + uw + '" height="' + uh + '" opacity="' +
                Math.max(0, Math.min(1, KP.num(underlay.opacity))) + '" preserveAspectRatio="none"/>';
        body += '<rect x="' + ux + '" y="' + uy + '" width="' + uw + '" height="' + uh +
                '" fill="none" stroke="#c9a227" stroke-width="0.04" stroke-dasharray="0.3 0.2"/>';
      }

      layouts.forEach(function (lay, layIndex) {
        const slope = lay.slope;
        const selected = slope.id === selectedId;
        const material = KP.getMaterial(project, slope.materialId);
        const useful = KP.num(material.usefulWidth) || 1;
        const polygon = pointsAttr(pointsOf(lay));
        const outline = selected ? '#d7202a' : '#272727';
        const outlineWidth = selected ? 0.07 : 0.045;

        const rotated = !!(slope.rotation && slope.renderOrigin);
        body += '<g data-slope="' + esc(slope.id) + '" style="cursor:pointer">';
        if (rotated) {
          body += '<g transform="rotate(' + slope.rotation + ' ' +
            slope.renderOrigin.x + ' ' + slope.renderOrigin.y + ')">';
        }
        body += '<polygon points="' + polygon + '" fill="#fafafa" stroke="none"/>';

        // Листы
        const startRight = (slope.layoutStart === 'right') !== !!slope.layoutMirror;
        let startX = startRight ? lay.w : 0;
        const startEdgeIndex = slope.layoutMode === 'manual'
          ? null
          : (slope.layoutMode === 'axis' && Number.isInteger(slope.axisEdge)
            ? slope.axisEdge
            : (Number.isInteger(slope.eaveEdge) ? slope.eaveEdge : null));
        if (slope.shape === 'polygon' && Array.isArray(slope.points) && startEdgeIndex != null) {
          const pts = slope.points;
          const a = pts[startEdgeIndex];
          const b = pts[(startEdgeIndex + 1) % pts.length];
          if (a && b) {
            const x1 = KP.num(a.x);
            const x2 = KP.num(b.x);
            startX = startRight ? Math.max(x1, x2) : Math.min(x1, x2);
          }
        }
        startX = Math.max(0, Math.min(lay.w, startX));
        const dir = startRight ? -1 : 1;
        const sideBefore = startRight ? (lay.w - startX) : startX;
        const sideAfter = startRight ? startX : (lay.w - startX);
        const kFrom = -Math.ceil(sideBefore / useful) - 1;
        const kTo = Math.ceil(sideAfter / useful) + 1;
        const fullWidth = KP.num(material.fullWidth) || useful;
        const hiddenWidth = Math.max(0, fullWidth - useful);
        const lockOverlap = Math.max(0, KP.num(material.lockOverlap) / 1000);
        const eaveOverhang = Math.max(0, KP.num(material.eaveOverhang) / 1000);
        const eaveIntervals = eaveXIntervals(slope, lay.w);
        // Длины листов подбираются по каждой полосе отдельно: на треугольных
        // скатах и у вырезов высота полосы своя, поэтому и лист свой.
        // Ряды укладываются от карниза вверх — лист подрезается по контуру.
        const stripeRows = function (height, eaveY) {
          const lengths = KP.applySheetDeltas(
            KP.sheetLengths(height, material, KP.num(slope.rounding)),
            slope.sheetLengthDeltas,
            material
          );
          const rows = [];
          let bottom = eaveY;
          for (let i = 0; i < lengths.length; i++) {
            const length = Math.max(0, lengths[i]);
            rows.push({ length: length, top: bottom - length, bottom: bottom });
            bottom -= Math.max(0, length - lockOverlap);
          }
          return rows;
        };
        let hiddenVertical = '';
        let hiddenHorizontal = '';
        let overhangMarkup = '';
        body += '<g clip-path="url(#kp-clip-' + esc(slope.id) + ')">';
        let stripeIndex = 0;
        for (let k = kFrom; k <= kTo; k++) {
          const edgeA = startX + dir * k * useful;
          const edgeB = edgeA + dir * useful;
          const x0 = lay.x + Math.max(0, Math.min(edgeA, edgeB));
          const x1 = lay.x + Math.min(lay.w, Math.max(edgeA, edgeB));
          const width = x1 - x0;
          if (width <= 1e-6) continue;
          const fill = stripeIndex % 2 === 0 ? '#fbe3e4' : '#fff5f5';
          stripeIndex += 1;
          body += '<rect x="' + x0.toFixed(4) + '" y="' + (lay.y - 0.02).toFixed(4) + '" width="' + width.toFixed(4) +
                  '" height="' + (lay.h + 0.04).toFixed(4) +
                  '" fill="' + fill + '" stroke="#e9a7aa" stroke-width="0.022"/>';

          const xc = (x0 + x1) / 2;
          const localX = xc - lay.x;
          const span = KP.spanAt(slope, localX);
          const spanTop = lay.y + (lay.h - span.top);
          const spanBottom = lay.y + (lay.h - span.bottom);
          // Высота полосы — по правилу подрезки выбранного ската.
          const stripeHeight = KP.stripHeight(slope, x0 - lay.x, x1 - lay.x);
          const rows = stripeRows(stripeHeight, spanBottom);
          // Подпись — полная длина листа, включая скрытую часть под
          // нахлёстом. Для треугольных скатов и вырезов длина считается
          // по своей полосе, поэтому подписи у полос разные.
          if (width > 0.28) {
            rows.forEach(function (row) {
              const from = Math.max(row.top, spanTop);
              const to = Math.min(row.bottom, spanBottom);
              if (to - from <= 0.22) return;
              const labelY = (from + to) / 2;
              const labelSize = Math.min(0.20, (to - from) * 0.5, width * 0.6).toFixed(3);
              body += '<text x="' + xc.toFixed(4) + '" y="' + labelY.toFixed(4) +
                      '" text-anchor="middle" dominant-baseline="middle" font-size="' + labelSize + '" ' +
                      'font-family="Geologica, Segoe UI, Arial, sans-serif" fill="#8c1b22" ' +
                      'transform="rotate(-90 ' + xc.toFixed(4) + ' ' + labelY.toFixed(4) + ')">' +
                      KP.fmt(row.length, 3) + '</text>';
            });
          }

          // Горизонтальные стыки внутри полосы: вышележащий лист
          // перекрывает нижележащий на lockOverlap.
          rows.forEach(function (row, rowIndex) {
            if (rowIndex === rows.length - 1) return;
            const y = row.top;
            if (y > spanBottom + 1e-6) return;
            body += '<line x1="' + x0.toFixed(4) + '" y1="' + y.toFixed(4) +
                    '" x2="' + x1.toFixed(4) + '" y2="' + y.toFixed(4) +
                    '" stroke="#e08a8f" stroke-width="0.03" stroke-dasharray="0.12 0.08"/>';
            if (lockOverlap > 1e-6) {
              hiddenHorizontal += '<rect x="' + x0.toFixed(4) + '" y="' + (y - lockOverlap).toFixed(4) +
                '" width="' + width.toFixed(4) + '" height="' + lockOverlap.toFixed(4) +
                '" fill="rgba(215,32,42,0.05)" stroke="#c96a70" stroke-width="0.022" stroke-dasharray="0.09 0.07"/>';
            }
          });

          // Невидимая часть листа под вертикальным нахлёстом
          if (hiddenWidth > 1e-6) {
            const hiddenEdge = edgeB + dir * hiddenWidth;
            const hx0 = lay.x + Math.max(0, Math.min(edgeB, hiddenEdge));
            const hx1 = lay.x + Math.min(lay.w, Math.max(edgeB, hiddenEdge));
            // Только по фактической кромке в точке стыка, не по центру полосы.
            // Для triangle/trapezoid KP.spanAt возвращает top = height - length.
            const hiddenSpan = KP.spanAt(slope, Math.max(0.0001, Math.min(lay.w - 0.0001, hiddenEdge)));
            if (hx1 - hx0 > 1e-6 && hiddenSpan.length > 1e-6) {
              hiddenVertical += '<rect x="' + hx0.toFixed(4) + '" y="' + (lay.y + (lay.h - hiddenSpan.top)).toFixed(4) +
                '" width="' + (hx1 - hx0).toFixed(4) + '" height="' + hiddenSpan.length.toFixed(4) +
                '" fill="rgba(215,32,42,0.07)" stroke="#c96a70" stroke-width="0.022" stroke-dasharray="0.09 0.07"/>';
              if (hiddenEdge >= 0 && hiddenEdge <= lay.w) {
                hiddenVertical += '<line x1="' + (lay.x + hiddenEdge).toFixed(4) + '" y1="' +
                  (lay.y + (lay.h - hiddenSpan.top)).toFixed(4) + '" x2="' + (lay.x + hiddenEdge).toFixed(4) +
                  '" y2="' + (lay.y + (lay.h - hiddenSpan.bottom)).toFixed(4) +
                  '" stroke="#c96a70" stroke-width="0.026" stroke-dasharray="0.12 0.08"/>';
              }
            }
          }

          // Свес листа за карниз — только на участках, где есть карниз
          if (eaveOverhang > 1e-6 && eaveIntervals.length) {
            const segFrom = x0 - lay.x;
            const segTo = x1 - lay.x;
            const hiddenEdge = hiddenWidth > 1e-6 ? edgeB + dir * hiddenWidth : null;
            const bottomAt = function (localX) {
              const safeX = Math.max(0.0001, Math.min(lay.w - 0.0001, localX));
              return lay.y + (lay.h - KP.spanAt(slope, safeX).bottom);
            };
            eaveIntervals.forEach(function (eave) {
              const from = Math.max(segFrom, eave.from);
              const to = Math.min(segTo, eave.to);
              if (to - from <= 1e-6) return;
              const bottomFrom = eave.y != null ? lay.y + (lay.h - eave.y) : bottomAt(from);
              const bottomTo = eave.y != null ? lay.y + (lay.h - eave.y) : bottomAt(to);
              overhangMarkup += '<polygon points="' + (lay.x + from).toFixed(4) + ',' + bottomFrom.toFixed(4) + ' ' +
                (lay.x + to).toFixed(4) + ',' + bottomTo.toFixed(4) + ' ' +
                (lay.x + to).toFixed(4) + ',' + (bottomTo + eaveOverhang).toFixed(4) + ' ' +
                (lay.x + from).toFixed(4) + ',' + (bottomFrom + eaveOverhang).toFixed(4) +
                '" fill="' + fill + '" stroke="#e08a8f" stroke-width="0.022" stroke-dasharray="0.09 0.07"/>';
              if (hiddenEdge == null) return;
              const hFrom = Math.max(Math.min(edgeB, hiddenEdge), eave.from);
              const hTo = Math.min(Math.max(edgeB, hiddenEdge), eave.to);
              if (hTo - hFrom > 1e-6) {
                const hbFrom = eave.y != null ? lay.y + (lay.h - eave.y) : bottomAt(hFrom);
                const hbTo = eave.y != null ? lay.y + (lay.h - eave.y) : bottomAt(hTo);
                overhangMarkup += '<polygon points="' + (lay.x + hFrom).toFixed(4) + ',' + hbFrom.toFixed(4) + ' ' +
                  (lay.x + hTo).toFixed(4) + ',' + hbTo.toFixed(4) + ' ' +
                  (lay.x + hTo).toFixed(4) + ',' + (hbTo + eaveOverhang).toFixed(4) + ' ' +
                  (lay.x + hFrom).toFixed(4) + ',' + (hbFrom + eaveOverhang).toFixed(4) +
                  '" fill="rgba(215,32,42,0.07)" stroke="#c96a70" stroke-width="0.022" stroke-dasharray="0.09 0.07"/>';
              }
              if (hiddenEdge >= eave.from - 1e-6 && hiddenEdge <= eave.to + 1e-6) {
                const lineBottom = eave.y != null ? lay.y + (lay.h - eave.y) : bottomAt(hiddenEdge);
                overhangMarkup += '<line x1="' + (lay.x + hiddenEdge).toFixed(4) + '" y1="' +
                  lineBottom.toFixed(4) + '" x2="' + (lay.x + hiddenEdge).toFixed(4) +
                  '" y2="' + (lineBottom + eaveOverhang).toFixed(4) +
                  '" stroke="#c96a70" stroke-width="0.026" stroke-dasharray="0.12 0.08"/>';
              }
            });
          }
        }
        // Горизонтальные стыки рисуются по каждой полосе отдельно (выше),
        // поэтому общая линия по всей ширине ската больше не нужна.
        body += hiddenVertical + hiddenHorizontal;
        body += '</g>';
        body += overhangMarkup;

        // Вырезы: материал не раскладывается, лист обрезается по контуру.
        const slopeCutouts = Array.isArray(slope.cutouts) ? slope.cutouts : [];
        slopeCutouts.forEach(function (cut) {
          if (!cut || !Array.isArray(cut.points) || cut.points.length < 3) return;
          const pts = cut.points.map(function (p) {
            return [lay.x + KP.num(p.x), lay.y + (lay.h - KP.num(p.y))];
          });
          body += '<polygon points="' + pointsAttr(pts) +
            '" fill="#ffffff" stroke="#b23a48" stroke-width="0.04" ' +
            'stroke-dasharray="0.16 0.1" stroke-linejoin="round"/>';
          const area = KP.polygonArea(cut.points);
          if (area > 0.15) {
            const cutCx = pts.reduce(function (sum, p) { return sum + p[0]; }, 0) / pts.length;
            const cutCy = pts.reduce(function (sum, p) { return sum + p[1]; }, 0) / pts.length;
            body += '<text x="' + cutCx.toFixed(4) + '" y="' + cutCy.toFixed(4) +
              '" text-anchor="middle" dominant-baseline="middle" font-size="0.17" ' +
              'font-family="Geologica, Segoe UI, Arial, sans-serif" fill="#b23a48">' +
              'вырез ' + KP.fmt(area) + ' м²</text>';
          }
        });

        // Контур
        body += '<polygon points="' + polygon + '" fill="none" stroke="' + outline +
                '" stroke-width="' + outlineWidth + '" stroke-linejoin="round"/>';

        // Размеры сторон контура: буква, длина и пометка «без доборов».
        if (drawSettings.showDimensions) {
          const letterSource = 'abcdefghijklmnop';
          const localPts = KP.slopePoints(slope);
          const screenPts = localPts.map(function (p) {
            return [lay.x + p[0], lay.y + (lay.h - p[1])];
          });
          const centroid = screenPts.reduce(function (sum, p) {
            return [sum[0] + p[0], sum[1] + p[1]];
          }, [0, 0]);
          centroid[0] /= Math.max(1, screenPts.length);
          centroid[1] /= Math.max(1, screenPts.length);
          const legend = [];
          screenPts.forEach(function (a, index) {
            const b = screenPts[(index + 1) % screenPts.length];
            if (!a || !b) return;
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const length = Math.hypot(dx, dy);
            if (length < 0.3) return;
            const letter = letterSource[index] || String(index + 1);
            let nx = (a[0] + b[0]) / 2 - centroid[0];
            let ny = (a[1] + b[1]) / 2 - centroid[1];
            const norm = Math.hypot(nx, ny) || 1;
            nx /= norm;
            ny /= norm;
            const off = 0.42;
            const ax = a[0] + nx * off;
            const ay = a[1] + ny * off;
            const bx = b[0] + nx * off;
            const by = b[1] + ny * off;
            body += '<line x1="' + a[0].toFixed(4) + '" y1="' + a[1].toFixed(4) + '" x2="' + ax.toFixed(4) +
                    '" y2="' + ay.toFixed(4) + '" stroke="#b0b0b0" stroke-width="0.012"/>';
            body += '<line x1="' + b[0].toFixed(4) + '" y1="' + b[1].toFixed(4) + '" x2="' + bx.toFixed(4) +
                    '" y2="' + by.toFixed(4) + '" stroke="#b0b0b0" stroke-width="0.012"/>';
            body += '<line x1="' + ax.toFixed(4) + '" y1="' + ay.toFixed(4) + '" x2="' + bx.toFixed(4) +
                    '" y2="' + by.toFixed(4) + '" stroke="#9a9a9a" stroke-width="0.016"/>';
            let angle = Math.atan2(dy, dx) * 180 / Math.PI;
            if (angle > 90 || angle < -90) angle += 180;
            const tx = (ax + bx) / 2 + nx * 0.22;
            const ty = (ay + by) / 2 + ny * 0.22;
            body += '<text x="' + tx.toFixed(4) + '" y="' + ty.toFixed(4) +
                    '" text-anchor="middle" dominant-baseline="middle" font-size="0.19" ' +
                    'font-family="Geologica, Segoe UI, Arial, sans-serif" fill="#4a4a4a" ' +
                    'transform="rotate(' + angle.toFixed(2) + ' ' + tx.toFixed(4) + ' ' + ty.toFixed(4) + ')">' +
                    letter + ' = ' + KP.fmt(length, 3) + '</text>';
            legend.push(letter + ' = ' + KP.fmt(length, 3) + '; без доборов');
          });
          legend.forEach(function (row, index) {
            body += '<text x="' + lay.x.toFixed(4) + '" y="' + (lay.y + lay.h + 1.78 + index * 0.26).toFixed(4) +
                    '" font-size="0.19" font-family="Geologica, Segoe UI, Arial, sans-serif" fill="#4a4a4a">' +
                    row + '</text>';
          });
        }

        // Типы сторон: карниз, конёк, ребро, ендова, торец
        if (slope.shape === 'polygon' && Array.isArray(slope.edgeTypes)) {
          const localPoints = KP.slopePoints(slope);
          localPoints.forEach(function (a, index) {
            const b = localPoints[(index + 1) % localPoints.length];
            const style = EDGE_STYLES[slope.edgeTypes[index]];
            if (!style || !a || !b) return;
            body += '<line x1="' + (lay.x + a[0]).toFixed(4) + '" y1="' + (lay.y + (lay.h - a[1])).toFixed(4) +
              '" x2="' + (lay.x + b[0]).toFixed(4) + '" y2="' + (lay.y + (lay.h - b[1])).toFixed(4) +
              '" stroke="' + style.color + '" stroke-width="' + style.width + '"' +
              (style.dash ? ' stroke-dasharray="' + style.dash + '"' : '') +
              ' stroke-linecap="round"/>';
          });
        }

        // Направление листов: от стартовой стороны к противоположной
        if (rotated) {
          const manualDirection = slope.layoutMode === 'axis' || slope.layoutMode === 'manual';
          const startLabel = manualDirection ? 'старт' : 'карниз';
          const finishLabel = manualDirection ? 'конец' : 'конёк';
          const arrowX = lay.x + lay.w / 2;
          const arrowTop = lay.y + 0.25;
          const arrowBottom = lay.y + lay.h - 0.25;
          body += '<text x="' + arrowX.toFixed(4) + '" y="' + (lay.y + lay.h + 0.28).toFixed(4) +
            '" text-anchor="middle" font-size="0.18" font-weight="600" ' +
            'font-family="Geologica, Segoe UI, Arial, sans-serif" fill="#8c1b22">' + startLabel + '</text>';
          body += '<text x="' + arrowX.toFixed(4) + '" y="' + (lay.y - 0.16).toFixed(4) +
            '" text-anchor="middle" font-size="0.18" font-weight="600" ' +
            'font-family="Geologica, Segoe UI, Arial, sans-serif" fill="#8c1b22">' + finishLabel + '</text>';
          body += '<line data-slope-arrow="1" x1="' + arrowX.toFixed(4) + '" y1="' + arrowBottom.toFixed(4) +
            '" x2="' + arrowX.toFixed(4) + '" y2="' + arrowTop.toFixed(4) +
            '" stroke="#8c1b22" stroke-width="0.025" stroke-dasharray="0.1 0.08"/>';
          body += '<polygon data-slope-arrow="1" points="' + arrowX.toFixed(4) + ',' + arrowTop.toFixed(4) + ' ' +
            (arrowX - 0.1).toFixed(4) + ',' + (arrowTop + 0.16).toFixed(4) + ' ' +
            (arrowX + 0.1).toFixed(4) + ',' + (arrowTop + 0.16).toFixed(4) + '" fill="#8c1b22"/>';
        }

        // Подпись (порядковый номер не дублируем — он уже в названии «Скат №N»)
        const cx = lay.x + lay.w / 2;
        body += '<text data-slope-label="name" x="' + cx.toFixed(4) + '" y="' + (lay.y - 1.52).toFixed(4) + '" text-anchor="middle" font-size="0.30" ' +
                'font-weight="600" font-family="Geologica, Segoe UI, Arial, sans-serif" fill="#272727">' +
                esc(slope.name) + '</text>';
        if (drawSettings.showDimensions) {
          body += '<text data-slope-label="meta" x="' + cx.toFixed(4) + '" y="' + (lay.y - 1.12).toFixed(4) + '" text-anchor="middle" font-size="0.21" ' +
                  'font-family="Geologica, Segoe UI, Arial, sans-serif" fill="#6f6f6f">' +
                  esc(material.name) + ' · ' + KP.fmt(Math.max(0, KP.shapeArea(slope) - KP.cutoutArea(slope))) + ' м²</text>';
        }

        // Маркеры редактирования (для повёрнутой раскладки отключаем — меняйте контур в объекте DWG)
        if (selected && !rotated) {
          body += '<circle data-handle="br" data-slope="' + esc(slope.id) + '" ' +
                  'cx="' + (lay.x + lay.w).toFixed(4) + '" cy="' + (lay.y + lay.h).toFixed(4) +
                  '" r="0.24" fill="#d7202a" stroke="#fff" stroke-width="0.05" ' +
                  'style="cursor:nwse-resize"/>';
          if (slope.shape === 'trapezoid') {
            const tx = lay.x + (lay.w + lay.tw) / 2;
            body += '<circle data-handle="tr" data-slope="' + esc(slope.id) + '" ' +
                    'cx="' + tx.toFixed(4) + '" cy="' + lay.y.toFixed(4) + '" r="0.24" fill="#d7202a" stroke="#fff" ' +
                    'stroke-width="0.05" style="cursor:ew-resize"/>';
          }
        }

        if (rotated) body += '</g>';
        body += '</g>';
      });

      // Объекты, импортированные из DWG, рисуются поверх раскладки и доступны для выбора.
      if (objects.length) {
        body += '<g id="kp-objects-layer">';
        objects.forEach(function (obj) {
          body += objectMarkup(obj, obj.id === selectedObjectId);
        });
        body += '</g>';
      }

      svgEl.innerHTML = defs + body;
      if (drawState) updateDrawLayer();
    }

    function updateDirectionPickLayer() {
      if (!directionPick || !svgEl) return;
      let layer = svgEl.querySelector('#kp-direction-layer');
      if (!layer) {
        layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        layer.setAttribute('id', 'kp-direction-layer');
        layer.setAttribute('pointer-events', 'none');
        svgEl.appendChild(layer);
      }
      if (!directionPick.origin) {
        layer.innerHTML = '';
        return;
      }
      const origin = directionPick.origin;
      const cursor = directionPick.cursor || origin;
      const angle = Math.atan2(cursor.y - origin.y, cursor.x - origin.x) * 180 / Math.PI;
      const dx = cursor.x - origin.x;
      const dy = cursor.y - origin.y;
      const length = Math.hypot(dx, dy);
      let html = '<circle cx="' + origin.x + '" cy="' + origin.y + '" r="0.16" fill="#d7202a"/>';
      html += '<line x1="' + origin.x + '" y1="' + origin.y + '" x2="' + cursor.x + '" y2="' + cursor.y +
        '" stroke="#d7202a" stroke-width="0.05" vector-effect="non-scaling-stroke" stroke-dasharray="0.2 0.12"/>';
      if (length > 0.2) {
        const ux = dx / length;
        const uy = dy / length;
        const tip = { x: cursor.x, y: cursor.y };
        const back = { x: tip.x - ux * 0.35, y: tip.y - uy * 0.35 };
        const px = -uy * 0.18;
        const py = ux * 0.18;
        html += '<polygon points="' + tip.x + ',' + tip.y + ' ' +
          (back.x + px) + ',' + (back.y + py) + ' ' + (back.x - px) + ',' + (back.y - py) +
          '" fill="#d7202a"/>';
      }
      html += '<text x="' + cursor.x + '" y="' + (cursor.y - 0.25) + '" text-anchor="middle" font-size="0.2" ' +
        'font-family="Geologica, Segoe UI, Arial, sans-serif" fill="#d7202a">' +
        Math.round(((angle % 360) + 360) % 360) + '°</text>';
      layer.innerHTML = html;
    }

    function stopDirectionPick() {
      if (!directionPick) return;
      const pick = directionPick;
      directionPick = null;
      window.removeEventListener('keydown', onDirectionKey);
      if (svgEl) {
        svgEl.style.cursor = '';
        const layer = svgEl.querySelector('#kp-direction-layer');
        if (layer) layer.remove();
      }
      return pick;
    }

    function onDirectionKey(ev) {
      if (!directionPick) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        const pick = stopDirectionPick();
        if (pick && pick.onCancel) pick.onCancel();
      }
    }

    function startDirectionPick(options) {
      if (!svgEl) return false;
      if (drawState) cancelDraw();
      stopDirectionPick();
      directionPick = {
        origin: null,
        cursor: null,
        onPick: options && options.onPick,
        onCancel: options && options.onCancel
      };
      svgEl.style.cursor = 'crosshair';
      window.addEventListener('keydown', onDirectionKey);
      return true;
    }

    function bindEvents() {
      svgEl.addEventListener('pointerdown', function (ev) {
        if (directionPick) {
          if (ev.button !== 0) return;
          const point = toSvg(ev);
          if (!directionPick.origin) {
            directionPick.origin = point;
            directionPick.cursor = point;
            updateDirectionPickLayer();
          } else {
            const origin = directionPick.origin;
            const angle = Math.atan2(point.y - origin.y, point.x - origin.x) * 180 / Math.PI;
            const callback = directionPick.onPick;
            stopDirectionPick();
            if (callback) callback({ origin: origin, point: point, angle: angle });
          }
          return;
        }
        if (drawState) {
          if (ev.button !== 0) return;
          handleDrawClick(ev);
          return;
        }
        if (ev.button !== 0) return;
        const objectGroup = ev.target.closest('[data-object]');
        if (objectGroup) {
          const id = objectGroup.getAttribute('data-object');
          if (options.onObjectSelect) options.onObjectSelect(id);
          startObjectDrag(id, ev);
          return;
        }
        const handle = ev.target.closest('[data-handle]');
        if (handle) {
          startDrag(handle, ev);
          return;
        }
        const group = ev.target.closest('[data-slope]');
        if (group) {
          const slopeId = group.getAttribute('data-slope');
          options.onSelect(slopeId);
          startSlopeDrag(slopeId, ev);
        }
      });

      svgEl.addEventListener('pointermove', function (ev) {
        if (directionPick) {
          directionPick.cursor = toSvg(ev);
          updateDirectionPickLayer();
          return;
        }
        if (!drawState) return;
        drawState.cursor = snapDrawPoint(toSvg(ev), ev);
        updateDrawLayer();
        if (drawState.onCursor) drawState.onCursor(drawState.cursor);
      });

      svgEl.addEventListener('pointerleave', function () {
        if (directionPick) {
          directionPick.cursor = null;
          updateDirectionPickLayer();
          return;
        }
        if (!drawState) return;
        drawState.cursor = null;
        updateDrawLayer();
      });

      svgEl.addEventListener('dblclick', function (ev) {
        if (directionPick) {
          ev.preventDefault();
          return;
        }
        if (drawState) {
          ev.preventDefault();
          finishDraw();
          return;
        }
        const objectGroup = ev.target.closest('[data-object]');
        if (objectGroup && options.onObjectDoubleClick) {
          ev.preventDefault();
          options.onObjectDoubleClick(objectGroup.getAttribute('data-object'));
        }
      });

      svgEl.addEventListener('contextmenu', function (ev) {
        if (!drawState) return;
        ev.preventDefault();
        finishDraw();
      });
    }

    function startObjectDrag(id, ev) {
      const project = options.getProject();
      const object = (project.objects || []).find(function (o) { return o.id === id; });
      if (!object) return;
      objectDrag = {
        id: id,
        start: toSvg(ev),
        original: JSON.parse(JSON.stringify(object)),
        moved: false
      };
      window.addEventListener('pointermove', onObjectDragMove);
      window.addEventListener('pointerup', onObjectDragEnd, { once: true });
      ev.preventDefault();
    }

    function onObjectDragMove(ev) {
      if (!objectDrag) return;
      const project = options.getProject();
      const object = (project.objects || []).find(function (o) { return o.id === objectDrag.id; });
      if (!object) return;

      const point = toSvg(ev);
      let dx = point.x - objectDrag.start.x;
      let dy = point.y - objectDrag.start.y;
      if (Math.hypot(dx, dy) < 0.02) return;

      if (drawSettings.snap) {
        const step = drawSettings.snapStep;
        dx = Math.round(dx / step) * step;
        dy = Math.round(dy / step) * step;
      }

      objectDrag.moved = true;
      if (Array.isArray(objectDrag.original.points) && objectDrag.original.points.length) {
        object.points = objectDrag.original.points.map(function (p) {
          return {
            x: Math.round((p.x + dx) * 1000) / 1000,
            y: Math.round((p.y + dy) * 1000) / 1000
          };
        });
      } else if (object.kind === 'circle') {
        object.cx = Math.round((objectDrag.original.cx + dx) * 1000) / 1000;
        object.cy = Math.round((objectDrag.original.cy + dy) * 1000) / 1000;
      } else if (object.kind === 'text') {
        object.x = Math.round((objectDrag.original.x + dx) * 1000) / 1000;
        object.y = Math.round((objectDrag.original.y + dy) * 1000) / 1000;
      }
      render();
    }

    function onObjectDragEnd() {
      window.removeEventListener('pointermove', onObjectDragMove);
      if (objectDrag && objectDrag.moved && options.onChange) options.onChange();
      objectDrag = null;
    }

    function startSlopeDrag(id, ev) {
      const project = options.getProject();
      const slope = project.slopes.find(function (s) { return s.id === id; });
      const lay = layoutMap[id];
      if (!slope || !lay) return;
      const offset = slope.dragOffset || { x: 0, y: 0 };
      slopeDrag = {
        id: id,
        startClient: { x: ev.clientX, y: ev.clientY },
        startOffset: {
          x: Number.isFinite(Number(offset.x)) ? Number(offset.x) : 0,
          y: Number.isFinite(Number(offset.y)) ? Number(offset.y) : 0
        },
        startOrigin: slope.renderOrigin
          ? { x: Number(slope.renderOrigin.x), y: Number(slope.renderOrigin.y) }
          : null,
        moved: false
      };
      if (svgEl) svgEl.style.cursor = 'move';
      window.addEventListener('pointermove', onSlopeDragMove);
      window.addEventListener('pointerup', onSlopeDragEnd, { once: true });
      ev.preventDefault();
    }

    function onSlopeDragMove(ev) {
      if (!slopeDrag) return;
      const project = options.getProject();
      const slope = project.slopes.find(function (s) { return s.id === slopeDrag.id; });
      if (!slope) return;
      // Экранную дельту переводим в мировую через текущий масштаб:
      // так перетаскивание не «уезжает», если холст меняет границы.
      let dx = (ev.clientX - slopeDrag.startClient.x) / scale;
      let dy = (ev.clientY - slopeDrag.startClient.y) / scale;
      if (Math.hypot(dx, dy) < 0.02) return;
      if (drawSettings.snap) {
        const step = drawSettings.snapStep;
        dx = Math.round(dx / step) * step;
        dy = Math.round(dy / step) * step;
      }
      slope.dragOffset = {
        x: Math.round((slopeDrag.startOffset.x + dx) * 1000) / 1000,
        y: Math.round((slopeDrag.startOffset.y + dy) * 1000) / 1000
      };
      if (slopeDrag.startOrigin && slope.renderOrigin) {
        slope.renderOrigin = {
          x: Math.round((slopeDrag.startOrigin.x + dx) * 1000) / 1000,
          y: Math.round((slopeDrag.startOrigin.y + dy) * 1000) / 1000
        };
      }
      slopeDrag.moved = true;
      render();
    }

    function onSlopeDragEnd() {
      window.removeEventListener('pointermove', onSlopeDragMove);
      if (slopeDrag && slopeDrag.moved && options.onChange) options.onChange();
      slopeDrag = null;
      if (svgEl) svgEl.style.cursor = drawState ? 'crosshair' : '';
    }

    function startDrag(handle, ev) {
      const project = options.getProject();
      const slopeId = handle.getAttribute('data-slope');
      const slope = project.slopes.find(function (s) { return s.id === slopeId; });
      const lay = layoutMap[slopeId];
      if (!slope || !lay) return;

      drag = {
        slopeId: slopeId,
        handle: handle.getAttribute('data-handle'),
        lay: lay,
        startW: KP.num(slope.width),
        startH: KP.num(slope.height),
        startTop: KP.num(slope.topWidth),
        startPoints: slope.shape === 'polygon' && Array.isArray(slope.points)
          ? slope.points.map(function (p) { return { x: p.x, y: p.y }; })
          : null,
        pointer: toSvg(ev)
      };

      ev.preventDefault();
      ev.stopPropagation();
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragEnd, { once: true });
    }

    function round2(value) {
      return Math.round(value * 100) / 100;
    }

    function onDragMove(ev) {
      if (!drag) return;
      const project = options.getProject();
      const slope = project.slopes.find(function (s) { return s.id === drag.slopeId; });
      if (!slope) return;
      const p = toSvg(ev);
      const dx = p.x - drag.pointer.x;
      const dy = p.y - drag.pointer.y;

      if (drag.handle === 'br') {
        const w = Math.max(0.5, drag.lay.w + dx);
        const h = Math.max(0.5, drag.lay.h + dy);
        if (slope.shape === 'polygon' && drag.startPoints) {
          const kx = w / drag.lay.w;
          const ky = h / drag.lay.h;
          slope.points = drag.startPoints.map(function (p) {
            return {
              x: Math.round(p.x * kx * 1000) / 1000,
              y: Math.round(p.y * ky * 1000) / 1000
            };
          });
        }
        slope.width = round2(w);
        slope.height = round2(h);
        if (slope.shape === 'trapezoid') {
          slope.topWidth = Math.min(slope.topWidth, slope.width);
        }
      } else if (drag.handle === 'tr') {
        const width = Math.max(0.5, drag.lay.w);
        const center = drag.lay.x + width / 2;
        const tw = (p.x - center) * 2;
        slope.topWidth = round2(Math.max(0, Math.min(width, tw)));
      }

      ev.preventDefault();
      options.onChange();
    }

    function onDragEnd() {
      drag = null;
      window.removeEventListener('pointermove', onDragMove);
    }

    /* ---------- интерактивное черчение фигуры ---------- */

    function ensureSvgForDraw() {
      if (svgEl) {
        expandSvgForDraw();
        return;
      }
      container.innerHTML = '';
      svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svgEl.setAttribute('viewBox', '-2 -2 48 36');
      svgEl.setAttribute('width', '960');
      svgEl.setAttribute('height', '720');
      svgEl.style.width = '960px';
      svgEl.style.height = '720px';
      svgEl.innerHTML =
        '<defs><pattern id="kp-grid-draw" width="1" height="1" patternUnits="userSpaceOnUse">' +
          '<path d="M 1 0 L 0 0 0 1" fill="none" stroke="#ececec" stroke-width="0.018"/>' +
        '</pattern></defs>' +
        '<rect x="-2" y="-2" width="48" height="36" fill="#ffffff"/>' +
        '<rect x="-2" y="-2" width="48" height="36" fill="url(#kp-grid-draw)"/>';
      container.appendChild(svgEl);
      bindEvents();
    }

    // При черчении поверх существующих скатов расширяем рабочую область SVG:
    // иначе SVG заканчивается сразу за контуром, и клик «вне ската» не
    // попадает в него — первую точку можно поставить только внутри контура.
    function expandSvgForDraw() {
      if (!svgEl) return;
      const vb = (svgEl.getAttribute('viewBox') || '0 0 10 10').split(/\s+/).map(Number);
      if (vb.length !== 4 || vb.some(function (v) { return !Number.isFinite(v); })) return;
      const oldX = vb[0];
      const oldY = vb[1];
      const oldW = vb[2];
      const oldH = vb[3];
      const extraX = Math.max(12, oldW * 0.35);
      const extraY = Math.max(9, oldH * 0.35);
      const nx = oldX - extraX;
      const ny = oldY - extraY;
      const nw = oldW + extraX * 2;
      const nh = oldH + extraY * 2;
      svgEl.setAttribute('viewBox', nx + ' ' + ny + ' ' + nw + ' ' + nh);
      const pixelW = Math.max(320, Math.round(nw * scale));
      const pixelH = Math.max(240, Math.round(nh * scale));
      svgEl.setAttribute('width', pixelW);
      svgEl.setAttribute('height', pixelH);
      svgEl.style.width = pixelW + 'px';
      svgEl.style.height = pixelH + 'px';

      let bg = svgEl.querySelector('#kp-draw-bg');
      if (!bg) {
        bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        bg.setAttribute('id', 'kp-draw-bg');
        bg.setAttribute('fill', '#ffffff');
        svgEl.insertBefore(bg, svgEl.firstChild);
      }
      bg.setAttribute('x', nx);
      bg.setAttribute('y', ny);
      bg.setAttribute('width', nw);
      bg.setAttribute('height', nh);

      const pattern = svgEl.querySelector('#kp-grid') ? 'kp-grid'
        : (svgEl.querySelector('#kp-grid-draw') ? 'kp-grid-draw' : null);
      let grid = svgEl.querySelector('#kp-draw-grid');
      if (!grid && pattern) {
        grid = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        grid.setAttribute('id', 'kp-draw-grid');
        grid.setAttribute('fill', 'url(#' + pattern + ')');
        svgEl.insertBefore(grid, bg.nextSibling);
      }
      if (grid) {
        grid.setAttribute('x', nx);
        grid.setAttribute('y', ny);
        grid.setAttribute('width', nw);
        grid.setAttribute('height', nh);
        grid.style.display = drawSettings.showGrid ? '' : 'none';
      }

      // Сохраняем видимое положение контента после расширения области.
      requestAnimationFrame(function () {
        container.scrollLeft += Math.round((oldX - nx) * scale);
        container.scrollTop += Math.round((oldY - ny) * scale);
      });
    }

    function getDrawLayer() {
      if (!svgEl) return null;
      let layer = svgEl.querySelector('#kp-draw-layer');
      if (!layer) {
        layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        layer.setAttribute('id', 'kp-draw-layer');
        layer.setAttribute('pointer-events', 'none');
        svgEl.appendChild(layer);
      }
      return layer;
    }

    function findOsnap(point) {
      if (!drawState) return null;
      const tolerance = 10 / scale;
      let best = null;
      let bestDistance = tolerance;
      const consider = function (x, y, type) {
        const distance = Math.hypot(point.x - x, point.y - y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x: x, y: y, type: type };
        }
      };

      const project = options.getProject();
      project.slopes.forEach(function (slope) {
        const lay = layoutMap[slope.id];
        if (!lay) return;
        const pts = worldPointsOf(lay).map(function (p) {
          return { x: p[0], y: p[1] };
        });
        pts.forEach(function (p) { consider(p.x, p.y, 'endpoint'); });
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          consider((a.x + b.x) / 2, (a.y + b.y) / 2, 'midpoint');
        }
      });

      drawState.points.forEach(function (p, index) {
        if (index === drawState.points.length - 1) return;
        consider(p.x, p.y, 'endpoint');
      });

      return best;
    }

    function snapDrawPoint(point, ev) {
      if (ev && ev.altKey) {
        return { x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000 };
      }

      if (drawSettings.osnap) {
        const candidate = findOsnap(point);
        if (candidate) {
          if (drawState) drawState.snap = candidate;
          return { x: candidate.x, y: candidate.y };
        }
      }
      if (drawState) drawState.snap = null;

      let x = point.x;
      let y = point.y;

      if (drawSettings.snap) {
        const step = drawSettings.snapStep;
        x = Math.round(x / step) * step;
        y = Math.round(y / step) * step;
      }

      const useOrtho = drawSettings.ortho || (ev && ev.shiftKey);
      const anchor = drawState && drawState.points.length
        ? drawState.points[drawState.points.length - 1]
        : null;

      if (anchor && (useOrtho || drawSettings.polar)) {
        const dx = x - anchor.x;
        const dy = y - anchor.y;
        const length = Math.hypot(dx, dy);
        if (length > 1e-9) {
          let angle = Math.atan2(-dy, dx);
          if (useOrtho) {
            const stepAngle = Math.PI / 2;
            angle = Math.round(angle / stepAngle) * stepAngle;
          } else {
            const stepAngle = drawSettings.polarStep * Math.PI / 180;
            angle = Math.round(angle / stepAngle) * stepAngle;
          }
          x = anchor.x + length * Math.cos(angle);
          y = anchor.y - length * Math.sin(angle);
        }
      }

      return {
        x: Math.round(x * 1000) / 1000,
        y: Math.round(y * 1000) / 1000
      };
    }

    function handleDrawClick(ev) {
      if (!drawState) return;
      const p = snapDrawPoint(toSvg(ev), ev);
      const pts = drawState.points;
      if (pts.length >= 3 && Math.hypot(p.x - pts[0].x, p.y - pts[0].y) < 0.35) {
        ev.preventDefault();
        finishDraw();
        return;
      }
      pts.push(p);
      drawState.typed = '';
      drawState.pendingAngle = null;
      drawState.cursor = p;
      updateDrawLayer();
      if (drawState.onCursor) drawState.onCursor(p);
      ev.preventDefault();
    }

    function cleanDrawPoints(points) {
      const out = [];
      points.forEach(function (p) {
        const last = out[out.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.05) out.push(p);
      });
      if (out.length > 1) {
        const first = out[0];
        const last = out[out.length - 1];
        if (Math.hypot(first.x - last.x, first.y - last.y) < 0.05) out.pop();
      }
      return out;
    }

    function finishDraw() {
      if (!drawState) return;
      const pts = cleanDrawPoints(drawState.points);
      if (pts.length < 3) {
        if (!pts.length) { cancelDraw(); return; }
        alert(drawState.mode === 'line'
          ? 'Для ската нужно минимум 3 точки. Поставьте ещё точки или нажмите Esc.'
          : 'Для полилинии нужно минимум 3 вершины. Поставьте ещё вершины или нажмите Esc.');
        drawState.points = pts;
        updateDrawLayer();
        return;
      }
      const cb = drawState.onFinish;
      stopDraw();
      if (cb) cb(pts);
    }

    function cancelDraw() {
      if (!drawState) return;
      const cb = drawState.onCancel;
      stopDraw();
      if (cb) cb();
    }

    function stopDraw() {
      if (!drawState) return;
      const cb = drawState.onState;
      drawState = null;
      window.removeEventListener('keydown', onDrawKey);
      if (svgEl) {
        svgEl.style.cursor = '';
        const layer = svgEl.querySelector('#kp-draw-layer');
        if (layer) layer.remove();
      }
      if (cb) cb(false);
    }

    function addPolarPoint(length, angle) {
      if (!drawState) return false;
      const len = KP.num(length);
      const ang = KP.num(angle);
      if (!(len > 0)) return false;
      const last = drawState.points[drawState.points.length - 1] || { x: 0, y: 0 };
      const rad = ang * Math.PI / 180;
      const point = {
        x: Math.round((last.x + len * Math.cos(rad)) * 1000) / 1000,
        y: Math.round((last.y - len * Math.sin(rad)) * 1000) / 1000
      };
      drawState.points.push(point);
      drawState.cursor = point;
      drawState.typed = '';
      drawState.pendingAngle = null;
      updateDrawLayer();
      if (drawState.onCursor) drawState.onCursor(point);
      return true;
    }

    // Направление от последней вершины: по курсору, с учётом орто/поляр.
    function drawDirectionAngle() {
      if (!drawState || !drawState.points.length) return null;
      const anchor = drawState.points[drawState.points.length - 1];
      const cursor = drawState.cursor || anchor;
      let dx = cursor.x - anchor.x;
      let dy = cursor.y - anchor.y;
      if (Math.hypot(dx, dy) < 1e-6 && drawState.points.length > 1) {
        const prev = drawState.points[drawState.points.length - 2];
        dx = anchor.x - prev.x;
        dy = anchor.y - prev.y;
      }
      if (Math.hypot(dx, dy) < 1e-9) return null;
      let angle = Math.atan2(-dy, dx);
      if (drawSettings.ortho) {
        angle = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
      } else if (drawSettings.polar) {
        const step = Math.max(1, drawSettings.polarStep) * Math.PI / 180;
        angle = Math.round(angle / step) * step;
      }
      return angle;
    }

    function addPointAtAngle(length, angle) {
      if (!drawState || !drawState.points.length || !(length > 0) || angle == null) return false;
      const anchor = drawState.points[drawState.points.length - 1];
      const point = {
        x: Math.round((anchor.x + length * Math.cos(angle)) * 1000) / 1000,
        y: Math.round((anchor.y - length * Math.sin(angle)) * 1000) / 1000
      };
      drawState.points.push(point);
      drawState.cursor = point;
      drawState.typed = '';
      drawState.pendingAngle = null;
      updateDrawLayer();
      if (drawState.onCursor) drawState.onCursor(point);
      return true;
    }

    // Ввод длины с клавиатуры по текущему направлению (орто/поляр).
    function applyTypedLength() {
      if (!drawState) return false;
      const length = KP.num(drawState.typed);
      const angle = drawState.pendingAngle != null
        ? drawState.pendingAngle * Math.PI / 180
        : drawDirectionAngle();
      if (!(length > 0)) {
        drawState.typed = '';
        updateDrawLayer();
        return false;
      }
      return addPointAtAngle(length, angle);
    }

    function applyTypedPoint() {
      if (!drawState) return;
      const raw = drawState.typed.replace(/\s+/g, '');
      drawState.typed = '';
      if (!raw) { updateDrawLayer(); return; }
      const isRelative = raw.charAt(0) === '@';
      const body = isRelative ? raw.slice(1) : raw;

      if (body.indexOf('<') >= 0) {
        const polar = body.split('<');
        addPolarPoint(polar[0], polar[1]);
        return;
      }

      const parts = body.indexOf(';') >= 0 ? body.split(';') : body.split(',');
      if (parts.length < 2) { updateDrawLayer(); return; }
      let x = KP.num(parts[0]);
      let y = KP.num(parts[1]);
      if (isRelative) {
        const last = drawState.points[drawState.points.length - 1] || { x: 0, y: 0 };
        x += last.x;
        y += last.y;
      }
      drawState.points.push({ x: x, y: y });
      drawState.cursor = { x: x, y: y };
      drawState.pendingAngle = null;
      updateDrawLayer();
      if (drawState.onCursor) drawState.onCursor(drawState.cursor);
    }

    function onDrawKey(ev) {
      if (!drawState) return;
      const key = ev.key;

      if (key === 'Escape') {
        ev.preventDefault();
        if (drawState.pendingAngle != null) {
          drawState.pendingAngle = null;
          updateDrawLayer();
        } else if (drawState.typed) {
          drawState.typed = '';
          updateDrawLayer();
        } else {
          cancelDraw();
        }
        return;
      }

      if (key === 'Enter' || key === 'NumpadEnter') {
        ev.preventDefault();
        if (drawState.typed) {
          const raw = drawState.typed.replace(/\s+/g, '');
          const simpleValue = /^-?\d+(?:[.,]\d+)?$/.test(raw);
          const polarMode = !drawSettings.ortho && drawSettings.polar;
          if (simpleValue && polarMode && drawState.pendingAngle == null) {
            // Полярный режим: первым вводится угол, затем длина.
            drawState.pendingAngle = ((KP.num(raw) % 360) + 360) % 360;
            drawState.typed = '';
            updateDrawLayer();
            return;
          }
          if (simpleValue && (drawSettings.ortho || drawSettings.polar || drawState.pendingAngle != null)) {
            applyTypedLength();
            return;
          }
          applyTypedPoint();
        } else {
          finishDraw();
        }
        return;
      }

      if (key === 'c' || key === 'C') {
        ev.preventDefault();
        drawState.typed = '';
        drawState.pendingAngle = null;
        finishDraw();
        return;
      }

      if (key === 'u' || key === 'U' || (ev.ctrlKey && (key === 'z' || key === 'Z'))) {
        ev.preventDefault();
        if (drawState.typed) drawState.typed = '';
        else if (drawState.pendingAngle != null) drawState.pendingAngle = null;
        else drawState.points.pop();
        updateDrawLayer();
        return;
      }

      if (key === 'Backspace') {
        ev.preventDefault();
        if (drawState.typed) drawState.typed = drawState.typed.slice(0, -1);
        else if (drawState.pendingAngle != null) drawState.pendingAngle = null;
        else drawState.points.pop();
        updateDrawLayer();
        return;
      }

      if (key.length === 1 && /[0-9.,@;\-\s<]/.test(key)) {
        drawState.typed += key;
        ev.preventDefault();
        updateDrawLayer();
      }
    }

    function updateDrawLayer() {
      if (!drawState || !svgEl) return;
      const layer = getDrawLayer();
      if (!layer) return;

      const pts = drawState.points;
      const cur = drawState.cursor;
      const vb = (svgEl.getAttribute('viewBox') || '0 0 20 20').split(/\s+/).map(Number);
      const vx = vb[0];
      const vy = vb[1];
      const vw = vb[2];
      const vh = vb[3];
      const font = 'Geologica, Segoe UI, Arial, sans-serif';
      let html = '';

      // Предпросмотр по введённой длине (орто/поляр/после ввода угла).
      let typedPreview = null;
      if (drawState.typed && /^-?\d+(?:[.,]\d+)?$/.test(drawState.typed.replace(/\s+/g, '')) &&
          pts.length && (drawSettings.ortho || drawSettings.polar || drawState.pendingAngle != null)) {
        const typedLength = KP.num(drawState.typed);
        const typedAngle = drawState.pendingAngle != null
          ? drawState.pendingAngle * Math.PI / 180
          : drawDirectionAngle();
        if (typedLength > 0 && typedAngle != null) {
          const anchor = pts[pts.length - 1];
          typedPreview = {
            x: Math.round((anchor.x + typedLength * Math.cos(typedAngle)) * 1000) / 1000,
            y: Math.round((anchor.y - typedLength * Math.sin(typedAngle)) * 1000) / 1000
          };
        }
      }

      const isLineMode = drawState.mode === 'line';
      const title = isLineMode ? 'ЧЕРЧЕНИЕ ОТРЕЗКАМИ' : 'ЧЕРЧЕНИЕ ПОЛИЛИНИЕЙ';
      html += '<text x="' + (vx + 0.4) + '" y="' + (vy + 0.7) + '" font-size="0.28" font-weight="600" ' +
        'fill="#a3161d" font-family="' + font + '">' + title + '</text>';
      html += '<text x="' + (vx + 0.4) + '" y="' + (vy + 1.13) + '" font-size="0.2" fill="#8a6a6c" ' +
        'font-family="' + font + '">' + (isLineMode ? 'ЛКМ — конец отрезка' : 'ЛКМ — вершина') +
        ' · число + Enter — длина по направлению · в поляр — сначала угол, затем длина' +
        ' · X,Y — абсолютно · @dX,dY — относительно · L&lt;A — полярно</text>';
      const modeText = 'Сетка ' + (drawSettings.snap ? KP.fmt(drawSettings.snapStep) + ' м' : 'выкл') +
        ' · Оснап ' + (drawSettings.osnap ? 'вкл' : 'выкл') + ' · ' +
        (drawSettings.ortho ? 'Орто' : (drawSettings.polar ? 'Поляр ' + drawSettings.polarStep + '°' : 'Свободно'));
      html += '<text x="' + (vx + 0.4) + '" y="' + (vy + 1.52) + '" font-size="0.19" fill="#8a6a6c" ' +
        'font-family="' + font + '">' + modeText + ' · U — отменить точку · Shift — орто · Alt — без привязки</text>';

      if (cur) {
        html += '<line x1="' + vx + '" y1="' + cur.y + '" x2="' + (vx + vw) + '" y2="' + cur.y +
          '" stroke="#d7202a" stroke-width="0.02" stroke-dasharray="0.25 0.2" opacity="0.35"/>';
        html += '<line x1="' + cur.x + '" y1="' + vy + '" x2="' + cur.x + '" y2="' + (vy + vh) +
          '" stroke="#d7202a" stroke-width="0.02" stroke-dasharray="0.25 0.2" opacity="0.35"/>';
        html += '<rect x="' + (cur.x - 0.08) + '" y="' + (cur.y - 0.08) + '" width="0.16" height="0.16" fill="#d7202a"/>';
      }

      if (drawState.snap) {
        const snap = drawState.snap;
        if (snap.type === 'endpoint') {
          html += '<rect x="' + (snap.x - 0.15) + '" y="' + (snap.y - 0.15) + '" width="0.3" height="0.3" ' +
            'fill="none" stroke="#1f8a70" stroke-width="0.05"/>';
        } else {
          html += '<polygon points="' + snap.x + ',' + (snap.y - 0.2) + ' ' +
            (snap.x - 0.2) + ',' + (snap.y + 0.14) + ' ' +
            (snap.x + 0.2) + ',' + (snap.y + 0.14) + '" fill="none" stroke="#1f8a70" stroke-width="0.05"/>';
        }
        html += '<text x="' + (snap.x + 0.28) + '" y="' + (snap.y - 0.24) + '" font-size="0.19" ' +
          'fill="#1f8a70" font-family="' + font + '">' + (snap.type === 'endpoint' ? 'конец' : 'середина') + '</text>';
      }

      if (pts.length) {
        const last = pts[pts.length - 1];
        const rubber = typedPreview || cur;
        const chain = pts.map(function (p) { return p.x + ',' + p.y; });
        if (rubber) chain.push(rubber.x + ',' + rubber.y);
        html += '<polyline points="' + chain.join(' ') + '" fill="none" stroke="#d7202a" ' +
          'stroke-width="0.06" stroke-linejoin="round" stroke-linecap="round"/>';

        if (pts.length >= 2) {
          const closure = Math.hypot(last.x - pts[0].x, last.y - pts[0].y);
          html += '<line x1="' + last.x + '" y1="' + last.y + '" x2="' + pts[0].x + '" y2="' + pts[0].y +
            '" stroke="#d7202a" stroke-width="0.04" stroke-dasharray="0.18 0.14" opacity="' +
            (closure < 0.35 ? '0.95' : '0.6') + '"/>';
          if (closure > 0.8) {
            html += '<text x="' + ((last.x + pts[0].x) / 2) + '" y="' + ((last.y + pts[0].y) / 2 - 0.12) +
              '" text-anchor="middle" font-size="0.15" fill="#b0565c" font-family="' + font + '">' +
              KP.fmt(closure) + ' м</text>';
          }
        }
        if (pts.length >= 2 && rubber) {
          const poly = pts.map(function (p) { return p.x + ',' + p.y; }).concat([rubber.x + ',' + rubber.y]);
          html += '<polygon points="' + poly.join(' ') + '" fill="#d7202a" fill-opacity="0.07" stroke="none"/>';
        }
        pts.forEach(function (p, index) {
          html += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (index === 0 ? 0.15 : 0.11) +
            '" fill="' + (index === 0 ? '#d7202a' : '#ffffff') + '" stroke="#d7202a" stroke-width="0.04"/>';
          if (!isLineMode) {
            html += '<text x="' + (p.x + 0.15) + '" y="' + (p.y - 0.15) + '" font-size="0.14" ' +
              'fill="#b0565c" font-family="' + font + '">' + (index + 1) + '</text>';
          }
        });
        if (!isLineMode && cur && pts.length >= 2 &&
            Math.hypot(cur.x - pts[0].x, cur.y - pts[0].y) < 0.35) {
          html += '<circle cx="' + pts[0].x + '" cy="' + pts[0].y + '" r="0.28" fill="none" ' +
            'stroke="#1f8a70" stroke-width="0.045" stroke-dasharray="0.1 0.08"/>';
          html += '<text x="' + (pts[0].x + 0.36) + '" y="' + (pts[0].y + 0.32) + '" font-size="0.18" ' +
            'fill="#1f8a70" font-family="' + font + '">замкнуть</text>';
        }
      }

      if (pts.length > 1) {
        let perimeter = 0;
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const length = Math.hypot(b.x - a.x, b.y - a.y);
          perimeter += length;
          if (length < 0.7) continue;
          const angle = Math.atan2(-(b.y - a.y), b.x - a.x) * 180 / Math.PI;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          html += '<text x="' + mx + '" y="' + (my - 0.12) + '" text-anchor="middle" font-size="0.16" ' +
            'fill="#8a6a6c" font-family="' + font + '">' + KP.fmt(length) + ' м / ' +
            KP.fmt(angle, 0) + '°</text>';
        }
        const closureLength = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
        const areaPreview = pts.length >= 3 ? KP.polygonArea(pts) : 0;
        html += '<text x="' + (vx + 0.4) + '" y="' + (vy + 1.86) + '" font-size="0.19" ' +
          'fill="#8a6a6c" font-family="' + font + '">' +
          (isLineMode ? 'Отрезков: ' : 'Вершин: ') + (isLineMode ? pts.length - 1 : pts.length) +
          ' · Длина: ' + KP.fmt(perimeter) + ' м' +
          (pts.length >= 3 ? ' · Площадь: ' + KP.fmt(areaPreview) + ' м²' : '') +
          ' · Замыкание: ' + KP.fmt(closureLength) + ' м</text>';
      }

      if (cur && pts.length) {
        const last = pts[pts.length - 1];
        const ref = typedPreview || cur;
        const dx = ref.x - last.x;
        const dy = ref.y - last.y;
        const len = Math.hypot(dx, dy);
        const angle = Math.atan2(-dy, dx) * 180 / Math.PI;
        html += '<text x="' + (ref.x + 0.35) + '" y="' + (ref.y - 0.45) + '" font-size="0.22" ' +
          'fill="#a3161d" font-family="' + font + '">' + KP.fmt(len) + ' м · ' + KP.fmt(angle, 1) + '°</text>';
        html += '<text x="' + (ref.x + 0.35) + '" y="' + (ref.y - 0.18) + '" font-size="0.2" ' +
          'fill="#8a6a6c" font-family="' + font + '">X ' + KP.fmt(ref.x) + ' · Y ' + KP.fmt(ref.y) + '</text>';
      }

      // После ввода угла в полярном режиме показываем луч, по которому
      // будет отложена длина.
      if (drawState.pendingAngle != null && pts.length) {
        const last = pts[pts.length - 1];
        const rad = drawState.pendingAngle * Math.PI / 180;
        const guideLen = cur ? Math.max(0.5, Math.hypot(cur.x - last.x, cur.y - last.y)) : 2;
        const gx = last.x + guideLen * Math.cos(rad);
        const gy = last.y - guideLen * Math.sin(rad);
        html += '<line x1="' + last.x + '" y1="' + last.y + '" x2="' + gx + '" y2="' + gy +
          '" stroke="#d7202a" stroke-width="0.03" stroke-dasharray="0.18 0.12"/>';
        html += '<text x="' + (gx + 0.3) + '" y="' + (gy - 0.25) + '" font-size="0.22" fill="#a3161d" ' +
          'font-family="' + font + '">∠ ' + KP.fmt(drawState.pendingAngle, 1) + '°</text>';
      }

      if (drawState.typed) {
        const width = Math.max(1.2, drawState.typed.length * 0.18 + 0.4);
        const bx = cur ? cur.x + 0.3 : vx + 0.4;
        const by = cur ? cur.y + 0.35 : vy + 1.55;
        let prompt = '';
        if (drawState.pendingAngle != null) {
          prompt = '∠ ' + KP.fmt(drawState.pendingAngle, 1) + '° · длина, м';
        } else if (drawSettings.ortho) {
          prompt = 'Длина, м';
        } else if (drawSettings.polar) {
          prompt = 'Угол, °';
        }
        if (prompt) {
          html += '<text x="' + bx + '" y="' + (by - 0.1) + '" font-size="0.19" fill="#8a6a6c" ' +
            'font-family="' + font + '">' + prompt + '</text>';
        }
        html += '<rect x="' + bx + '" y="' + by + '" width="' + width + '" height="0.5" ' +
          'fill="#ffffff" stroke="#d7202a" stroke-width="0.04"/>';
        html += '<text x="' + (bx + 0.15) + '" y="' + (by + 0.35) + '" font-size="0.23" ' +
          'fill="#272727" font-family="Consolas, monospace">' + esc(drawState.typed) + '</text>';
      }

      layer.innerHTML = html;
    }

    let wheelDelta = 0;
    let wheelFrame = null;
    let wheelPoint = null;
    let wheelAnchorWorld = null;

    function applyZoom(factor, point, anchorWorld) {
      if (!factor || !point || !svgEl) return;
      const oldScale = scale;
      const nextScale = Math.max(MIN_SCALE, Math.min(240, oldScale * factor));
      if (Math.abs(nextScale - oldScale) < 0.01) return;

      // Мировая точка, которая должна остаться на месте при зуме.
      const world = anchorWorld || toSvg({ clientX: point.x, clientY: point.y });
      const holdWorldPoint = function () {
        const screen = svgToScreen(world);
        if (!screen) return;
        container.scrollLeft += screen.x - point.x;
        container.scrollTop += screen.y - point.y;
      };

      if (drawState) {
        // Во время черчения не перестраиваем холст: render() сбрасывает
        // viewBox, и первая точка «уезжает». Масштабируем текущий viewBox.
        const vb = (svgEl.getAttribute('viewBox') || '0 0 10 10').split(/\s+/).map(Number);
        scale = nextScale;
        if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
          const pw = Math.round(vb[2] * scale);
          const ph = Math.round(vb[3] * scale);
          svgEl.setAttribute('width', pw);
          svgEl.setAttribute('height', ph);
          svgEl.style.width = pw + 'px';
          svgEl.style.height = ph + 'px';
        }
        updateDrawLayer();
        holdWorldPoint();
        requestAnimationFrame(holdWorldPoint);
        if (options.onScaleChange) options.onScaleChange(scale);
        return;
      }

      scale = nextScale;
      render();
      holdWorldPoint();
      requestAnimationFrame(holdWorldPoint);
      if (options.onScaleChange) options.onScaleChange(scale);
    }

    function onWheel(ev) {
      if (!svgEl) return;

      // deltaMode: 0 — пиксели, 1 — строки, 2 — страницы.
      const mode = ev.deltaMode === 1 ? 16 : (ev.deltaMode === 2 ? 100 : 1);
      const delta = Math.max(-400, Math.min(400, ev.deltaY * mode));
      if (!delta) return;

      // Shift + колесо — обычная горизонтальная прокрутка холста.
      if (ev.shiftKey) {
        ev.preventDefault();
        container.scrollLeft += delta;
        return;
      }

      ev.preventDefault();
      wheelDelta += delta;
      if (drawState && drawState.points && drawState.points.length) {
        // После первой точки масштабируем от неё, а не от курсора.
        wheelAnchorWorld = { x: drawState.points[0].x, y: drawState.points[0].y };
        wheelPoint = svgToScreen(wheelAnchorWorld) || { x: ev.clientX, y: ev.clientY };
      } else {
        wheelAnchorWorld = null;
        wheelPoint = { x: ev.clientX, y: ev.clientY };
      }

      // Склеиваем серию событий колеса/тачпада в один шаг на кадр.
      if (wheelFrame) return;
      wheelFrame = requestAnimationFrame(function () {
        const total = Math.max(-400, Math.min(400, wheelDelta));
        const point = wheelPoint;
        const anchorWorld = wheelAnchorWorld;
        wheelDelta = 0;
        wheelAnchorWorld = null;
        wheelFrame = null;
        const factor = Math.max(0.85, Math.min(1.18, Math.pow(1.0015, -total)));
        applyZoom(factor, point, anchorWorld);
      });
    }

    function startPan(ev) {
      panState = {
        x: ev.clientX,
        y: ev.clientY,
        left: container.scrollLeft,
        top: container.scrollTop
      };
      container.style.cursor = 'grabbing';
      container.style.userSelect = 'none';
      if (svgEl) svgEl.style.cursor = 'grabbing';
      window.addEventListener('pointermove', onPanMove);
      window.addEventListener('pointerup', onPanEnd, { once: true });
      ev.preventDefault();
    }

    function onPanMove(ev) {
      if (!panState) return;
      container.scrollLeft = panState.left - (ev.clientX - panState.x);
      container.scrollTop = panState.top - (ev.clientY - panState.y);
      ev.preventDefault();
    }

    function onPanEnd() {
      panState = null;
      window.removeEventListener('pointermove', onPanMove);
      container.style.cursor = '';
      container.style.userSelect = '';
      if (svgEl) svgEl.style.cursor = drawState ? 'crosshair' : '';
    }

    function startPolygonDraw(userOptions) {
      const opts = userOptions || {};
      if (drawState) stopDraw();
      ensureSvgForDraw();
      drawState = {
        points: [],
        cursor: null,
        typed: '',
        pendingAngle: null,
        snap: null,
        mode: opts.mode === 'line' ? 'line' : 'polyline',
        onFinish: opts.onFinish,
        onCancel: opts.onCancel,
        onCursor: opts.onCursor,
        onState: opts.onState
      };
      svgEl.style.cursor = 'crosshair';
      window.addEventListener('keydown', onDrawKey);
      updateDrawLayer();
      if (drawState.onState) drawState.onState(true);
    }

    return {
      render: render,
      setScale: function (value) {
        scale = Math.max(MIN_SCALE, Math.min(240, value));
        render();
        if (options.onScaleChange) options.onScaleChange(scale);
      },
      getScale: function () { return scale; },
      getSvg: function () { return svgEl; },
      startPolygonDraw: startPolygonDraw,
      startDirectionPick: startDirectionPick,
      cancelDirectionPick: function () {
        const pick = stopDirectionPick();
        if (pick && pick.onCancel) pick.onCancel();
      },
      cancelDraw: cancelDraw,
      addPolarPoint: addPolarPoint,
      isDrawing: function () { return !!drawState; },
      getDrawSettings: function () { return Object.assign({}, drawSettings); },
      setDrawSetting: function (key, value) {
        if (Object.prototype.hasOwnProperty.call(drawSettings, key)) {
          drawSettings[key] = value;
          if (drawState) updateDrawLayer();
          if (key === 'showGrid' || key === 'showDimensions') render();
        }
      },
      toggleDrawSetting: function (key) {
        if (!Object.prototype.hasOwnProperty.call(drawSettings, key)) return null;
        drawSettings[key] = !drawSettings[key];
        if (drawState) updateDrawLayer();
        if (key === 'showGrid' || key === 'showDimensions') render();
        return drawSettings[key];
      },
      fitView: function (marginFactor) {
        render();
        if (!svgEl) return;
        const availW = Math.max(200, container.clientWidth - 40);
        const availH = Math.max(150, container.clientHeight - 40);

        let slopeBounds = null;
        Object.keys(layoutMap).forEach(function (id) {
          const layout = layoutMap[id];
          if (!layout) return;
          const points = layout.slope.rotation && layout.slope.renderOrigin
            ? worldPointsOf(layout)
            : pointsOf(layout);
          points.forEach(function (p) {
            if (!slopeBounds) {
              slopeBounds = { minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] };
            } else {
              slopeBounds.minX = Math.min(slopeBounds.minX, p[0]);
              slopeBounds.minY = Math.min(slopeBounds.minY, p[1]);
              slopeBounds.maxX = Math.max(slopeBounds.maxX, p[0]);
              slopeBounds.maxY = Math.max(slopeBounds.maxY, p[1]);
            }
          });
        });

        let nextScale;
        let centerX;
        let centerY;
        if (slopeBounds) {
          const spanX = Math.max(0.1, slopeBounds.maxX - slopeBounds.minX);
          const spanY = Math.max(0.1, slopeBounds.maxY - slopeBounds.minY);
          const factor = marginFactor && marginFactor > 0 ? marginFactor : 1.12;
          const targetW = spanX * factor;
          const targetH = spanY * factor;
          nextScale = Math.min(availW / targetW, availH / targetH);
          centerX = (slopeBounds.minX + slopeBounds.maxX) / 2;
          centerY = (slopeBounds.minY + slopeBounds.maxY) / 2;
        } else {
          const vb = (svgEl.getAttribute('viewBox') || '0 0 10 10').split(/\s+/).map(Number);
          if (!(vb[2] > 0) || !(vb[3] > 0)) return;
          nextScale = Math.min(availW / vb[2], availH / vb[3]);
          centerX = vb[0] + vb[2] / 2;
          centerY = vb[1] + vb[3] / 2;
        }

        scale = Math.max(MIN_SCALE, Math.min(240, nextScale));
        render();

        const vb = (svgEl.getAttribute('viewBox') || '0 0 10 10').split(/\s+/).map(Number);
        if (vb[2] > 0 && vb[3] > 0) {
          const scrollX = (centerX - vb[0]) * scale - container.clientWidth / 2;
          const scrollY = (centerY - vb[1]) * scale - container.clientHeight / 2;
          container.scrollLeft = Math.max(0, scrollX);
          container.scrollTop = Math.max(0, scrollY);
        }
        if (options.onScaleChange) options.onScaleChange(scale);
      },
      undoLastPoint: function () {
        if (!drawState) return;
        drawState.points.pop();
        updateDrawLayer();
      }
    };
  };

  /* Экспорт текущего холста в PNG */
  KP.exportCanvasPNG = function (svg, filename) {
    if (!svg) return false;
    const clone = svg.cloneNode(true);
    const vb = (svg.getAttribute('viewBox') || '0 0 10 10').split(/\s+/).map(Number);
    const width = Math.max(1, vb[2]);
    const height = Math.max(1, vb[3]);
    const pxScale = 60;
    clone.setAttribute('width', Math.round(width * pxScale));
    clone.setAttribute('height', Math.round(height * pxScale));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    const data = new XMLSerializer().serializeToString(clone);
    const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>' + data], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * pxScale);
      canvas.height = Math.round(height * pxScale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(function (png) {
        if (!png) return;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(png);
        link.download = filename || 'raskladka.png';
        link.click();
        setTimeout(function () { URL.revokeObjectURL(link.href); }, 2000);
      }, 'image/png');
    };

    img.onerror = function () {
      URL.revokeObjectURL(url);
      alert('Не удалось сформировать PNG.');
    };

    img.src = url;
    return true;
  };
})();
