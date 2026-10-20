/* Готовые шаблоны кровель и фасадов */
(function () {
  const KP = window.KP;

  function materialByType(project, type) {
    return project.materials.find(function (m) { return m.type === type; }) || project.materials[0];
  }

  function baseSlope(project, type, name, shape, width, height, topWidth, angle) {
    const material = materialByType(project, type);
    return {
      id: KP.uid('slope'),
      name: name,
      shape: shape,
      width: width,
      height: height,
      topWidth: topWidth || 0,
      materialId: material ? material.id : null,
      angle: angle || (type === 'siding' ? 90 : 30),
      rounding: 0
    };
  }

  KP.templates = [
    {
      id: 'single',
      name: 'Односкатная кровля',
      note: 'Один прямоугольный скат 10 × 5 м',
      build: function (project) {
        return [baseSlope(project, 'tile', 'Скат №1', 'rect', 10, 5, 0, 20)];
      }
    },
    {
      id: 'gable',
      name: 'Двускатная кровля',
      note: 'Два прямоугольных ската 10 × 5 м',
      build: function (project) {
        return [
          baseSlope(project, 'tile', 'Скат №1', 'rect', 10, 5, 0, 30),
          baseSlope(project, 'tile', 'Скат №2', 'rect', 10, 5, 0, 30)
        ];
      }
    },
    {
      id: 'hip',
      name: 'Вальмовая кровля',
      note: 'Две трапеции 12 × 5 м и два треугольника 6 × 5 м',
      build: function (project) {
        return [
          baseSlope(project, 'tile', 'Скат №1', 'trapezoid', 12, 5, 4, 30),
          baseSlope(project, 'tile', 'Скат №2', 'trapezoid', 12, 5, 4, 30),
          baseSlope(project, 'tile', 'Скат №3', 'triangle', 6, 5, 0, 30),
          baseSlope(project, 'tile', 'Скат №4', 'triangle', 6, 5, 0, 30)
        ];
      }
    },
    {
      id: 'facade',
      name: 'Фасад с сайдингом',
      note: 'Прямоугольный фасад 8 × 3 м',
      build: function (project) {
        return [baseSlope(project, 'siding', 'Скат №1', 'rect', 8, 3, 0, 90)];
      }
    },
    {
      id: 'shed-sheet',
      name: 'Навес / профлист',
      note: 'Односкатный навес 6 × 4 м под профлист',
      build: function (project) {
        return [baseSlope(project, 'sheet', 'Скат №1', 'rect', 6, 4, 0, 12)];
      }
    }
  ];
})();
