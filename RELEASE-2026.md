# Edición 2026: revisión funcional y publicación

Revisión realizada el 15 de septiembre de 2026. Web: `pclemente/LNWeb`; app iOS: `pclemente/LoteriaNavidad`; fuente de resultados: `pclemente/NumerosLoteriaNavidad`.

## Resultado de la comparación

| Función | iOS existente | Web 2026 |
| --- | --- | --- |
| Navidad y El Niño | Sí | Sí, con año explícito y colecciones separadas |
| Números con ceros iniciales | Sí | Normalización a cinco cifras |
| Importe y comentario | Arrays paralelos, importe entero en varios cálculos | Participaciones con céntimos y notas; edición individual |
| Histórico y comprobación conjunta | Sí | Sí, con validación de la fuente y estados pendientes |
| Premios principales y estado | Sí | Sí, cuando la fuente supera las comprobaciones |
| Compartir web y contacto | Sí | Sí |
| Conservación en el mismo dispositivo | UserDefaults | Almacenamiento local con recuperación de copia y escritura por etapas |
| Traslado de los números de iOS | No existía | Exportación iOS 2026 e importación JSON en web |
| Copia de seguridad independiente | No existía | Exportación e importación con validación, fusión e idempotencia |
| Uso sin conexión | Histórico nativo | Interfaz PWA y colección local tras la primera carga |
| Sincronización automática entre dispositivos | Zephyr/iCloud | **Pendiente**. Exportar/importar es traslado manual, no sincronización |
| Siri | Atajo para abrir el histórico | **No disponible** en la web |
| Donaciones mediante StoreKit | Función nativa | No se traslada como compra web |
| Apariencia | UIKit, tema del sistema | Diseño adaptable oscuro, foco visible y movimiento reducido |
| Telemetría | Firebase Analytics solo para estadísticas de iOS | Sin analítica ni SDK de Firebase |

Firebase se usa únicamente para estadísticas de iOS y no almacena los décimos. La colección nativa se conserva en UserDefaults/iCloud. La web no carga Firebase, y Firebase no traslada esa colección ni sustituye iCloud.

## Errores corregidos

- Una petición fallida ya no se interpreta como resultado sin premio.
- Las listas de 2025 no se usan para un ticket de Navidad 2026.
- Los importes no pierden sus decimales ni se sustituyen silenciosamente por 20 €.
- Las notas se insertan como texto, no como HTML ejecutable.
- El guardado exige persistencia correcta; no se anuncia éxito si falta almacenamiento.
- Los registros antiguos conservan año pendiente, en lugar de recibir un año inventado. Se conservan importes cero para revisión y notas de hasta 5.000 caracteres, sin truncarlas.
- Importar una copia no reemplaza toda la colección ni duplica una copia idéntica. Conserva también varias participaciones con el mismo número, importe y nota. Las copias de hasta 10 MB se validan antes de intentar guardarlas.
- Se retiraron Firebase y la analítica de la web; sus números y su navegación no se envían a ese servicio.
- La interfaz dejó de anunciar «datos en directo» sin verificarlo.

## Situación real del servicio de resultados

Al revisar los endpoints HTTPS de producción:

- Navidad: `status=4`; el resumen tiene `timestamp=1766414850`, correspondiente al 22 de diciembre de **2025**. No es una lista de Navidad 2026.
- El Niño: resultados de **2026**. El resumen da primer premio `06703`, pero `LoteriaElNino.json` no contiene ni `06703` ni `6703`. La lista contiene 36.112 números y su mayor premio es 750.000 €/billete (el segundo premio). La web rechaza este conjunto incoherente.
- El formato actual carece de `drawYear`, identificador de publicación y declaración de cobertura completa; la web deriva el año del timestamp del resumen y comprueba estados y premios principales. Esta validación reduce fallos detectables, pero **no demuestra la integridad de todos los reintegros/terminaciones**.
- El generador de `NumerosLoteriaNavidad` usa scraping de RTVE, mezcla ejecuciones de varios scripts y publica con `git add .` dentro de un bucle local. Hay solicitudes con `verify=False`. No se ha ejecutado ese generador ni publicado datos de premios inventados.

## Trabajo necesario antes de la campaña y la retirada total de iOS

1. Reparar y contrastar la lista completa de El Niño 2026 con SELAE, incluyendo el primer premio ausente. No basta con copiar el primer número del resumen: hay que comprobar importes y premios acumulables.
2. Preparar snapshots versionados de Navidad 2026 y El Niño 2027: `lottery`, `drawYear`, `generatedAt`, estado, origen y huella común en números/resumen/estado. Publicación atómica después de validar todas las páginas, HTTPS con certificados válidos, timeout y reintentos acotados. Conservar la última publicación válida si falla la extracción.
3. Antes del sorteo, publicar el estado «no comenzado» con el año explícito, sin reasignar los resultados antiguos a 2026. Al empezar, probar el recorrido de estados 0 → 1 → 2 → 3 → 4 contra una fuente autorizada. Archivar los años anteriores.
4. Para equivalencia con iCloud, diseñar un servicio de cuentas y sincronización independiente: acceso, aislamiento por propietario, conflictos, borrados sincronizados, operación offline, exportación y borrado de cuenta. La web actual no incluye ese servicio.
5. Mantener la configuración de Firebase Analytics exclusivamente en iOS para el bundle correcto y verificar la firma/App Store Connect. La web no utiliza ni publica configuración de Firebase.

## Comprobación de esta publicación

`npm test` cubre céntimos, migración web/iOS, importaciones repetidas y conflictivas, fallos de escritura, recuperación, consistencia de API, años, estados y caché. Se ha probado manualmente en navegador el alta `00123` con importe `2,50`, notas con caracteres HTML, edición a `10,75`, persistencia tras recarga e importación de una copia iOS con números de ambos sorteos. Se ha revisado el diseño de escritorio y móvil y abierto la interfaz con su colección después de detener el servidor local. 20 pruebas automáticas pasaron antes de publicar. Los tests no equivalen a una prueba con usuarios ni a contrastar todos los premios con SELAE.

La publicación web está orientada a guardar y trasladar la colección con seguridad. No debe anunciarse aún como sustituto con paridad total de iCloud/Siri, ni como fuente oficial de premios.
