# Mi Lotería · Navidad 2026

Web estática de [loterianavidad.pabloclementeperez.com](https://loterianavidad.pabloclementeperez.com), repositorio de producción independiente de la app iOS `pclemente/LoteriaNavidad`.

```sh
npm test
python3 -m http.server 8765 --bind 127.0.0.1
```

Abrir http://127.0.0.1:8765. Sin compilación ni dependencias de producción. Node 22 ejecuta las pruebas de contrato, persistencia, migración e importación. Los módulos JavaScript requieren servir por HTTP(S), no abrir `index.html` mediante `file://`.

## Funcionalidad

- Navidad y El Niño con selección explícita de año, décimos y participaciones en céntimos.
- Añadir, editar, eliminar y comprobar una colección; repetir el mismo número con distinta participación.
- Importación y exportación JSON compatible con la app iOS 2026, validación previa y fusión sin reemplazar toda la colección.
- Recuperación de almacenamiento y migración del formato anterior: sus tickets permanecen con año pendiente hasta que el usuario lo asigne.
- Consulta del estado y premios principales; resultados vinculados a su año. Los fallos de servidor, datos obsoletos y sorteos pendientes no se presentan como «sin premio».
- PWA instalable. Tras la primera carga correcta, la interfaz y la colección se pueden abrir sin conexión. Comprobar premios nuevos requiere red.
- Sin analítica web ni SDK de Firebase; los números, importes, notas y copias permanecen en el navegador.

Los datos son **locales a cada navegador**. Exportar e importar permite trasladarlos, pero no hay sincronización automática entre dispositivos, cuentas, Siri ni notificaciones de premios. No se debe anunciar paridad con iCloud.

## Despliegue

GitHub Pages debe usar **GitHub Actions**, HTTPS obligatorio y conservar el CNAME actual. El flujo `deploy-pages.yml` ejecuta las pruebas antes de publicar únicamente los ficheros públicos, sin incluir tests ni documentación de trabajo.

El service worker conserva cada versión de la interfaz como conjunto. Una actualización se instala en segundo plano y se activa cuando se cierran las pestañas de la versión anterior. Cambiar `CACHE` en `service-worker.js` en cada publicación que modifique recursos. Nunca almacena resultados como ficheros del shell: la caché de datos validada la controla la aplicación.

## Icono de la aplicación

La cabecera, el favicon y los accesos instalados utilizan el icono original de iOS (`AppIcon.appiconset/LOTERIAITUNES.jpg`), redimensionado a 32, 180, 192 y 512 píxeles.

## Firebase solo en iOS

La web no carga Firebase ni recoge estadísticas. Firebase Analytics se utiliza únicamente en la app **iOS**, mediante su `GoogleService-Info.plist` registrado para `com.pabloclementeperez.LoteriaNavidad`; no guarda ni sincroniza los décimos.

## Fuente de premios y campaña

Ver [RELEASE-2026.md](RELEASE-2026.md) para validación, límites de paridad y preparación del servicio de datos. Ninguna comprobación sustituye la lista oficial de SELAE.
