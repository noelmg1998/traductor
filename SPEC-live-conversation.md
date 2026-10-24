# DESARROLLO JAVASCRIPT — LIVE CONVERSATION
### Especificación oficial de Noel (pegada en el chat el 2026-10-21 21:50 EDT) — manda sobre cualquier instrucción anterior de esta pantalla.

1. Objetivo principal

Quiero que esta sea la pantalla de Traducción por Conversación en Vivo, manteniendo el diseño visual exactamente como la imagen de referencia.

La pantalla debe funcionar como una llamada telefónica combinada con un reproductor de audio inteligente, utilizando inteligencia artificial para traducir conversaciones entre dos personas en tiempo real.

Estilo obligatorio:

* Luxury Premium UI.
* Fondo negro azulado con detalles dorados.
* Efectos glassmorphism.
* Animaciones fluidas.
* Ondas de sonido reactivas.
* Botones circulares con iluminación.
* Diseño responsive para iPhone, Android, tablets y computadoras.
* Toda la interfaz debe funcionar en español o inglés, dependiendo del idioma seleccionado por el usuario.

⸻

2. Selector de idiomas

En la parte superior aparecen dos selectores:

Idioma de origen: English 🇺🇸

Idioma de destino: Spanish 🇪🇸

Funcionalidad JavaScript

* Al presionar cualquiera de los selectores, abrir un modal con buscador de idiomas.
* Permitir seleccionar los idiomas compatibles con el proveedor de traducción.
* Mostrar bandera, nombre e idioma seleccionado.
* Guardar las preferencias del usuario.
* Evitar seleccionar el mismo idioma en ambos lados.
* Al cambiar un idioma durante una conversación, reconfigurar el servicio de traducción sin perder el historial.
* Si existe audio en reproducción, detenerlo antes de efectuar el cambio.

Botón intercambiar idiomas

Al presionarlo:

* Intercambiar idioma de origen y destino.
* Animar las banderas con una rotación de 180 grados.
* Actualizar inmediatamente los indicadores de idioma.
* Reconfigurar el reconocimiento y la síntesis de voz.

Efecto: transición de 300 ms con iluminación dorada.

⸻

3. Esfera central de audio inteligente

La esfera dorada será el elemento visual principal de la pantalla.

Funcionalidad JavaScript

La esfera debe reaccionar al audio real capturado por el micrófono y a la reproducción de audio generado.

Implementar cuatro estados:

Estado 1 — Escuchando

* Iluminación dorada suave.
* Ondas pequeñas que reaccionan al volumen de la voz.
* Movimiento circular lento.
* Texto: “Escuchando…”

Estado 2 — Procesando

* Animación de partículas desplazándose alrededor de la esfera.
* Pulso luminoso.
* Texto: “Procesando voz…”

Estado 3 — Traduciendo

* Ondas desplazándose hacia el idioma de destino.
* Animación dorada de mayor intensidad.
* Texto: “Traduciendo…”

Estado 4 — Reproduciendo

* Ondas sincronizadas con el audio traducido.
* Halo luminoso alrededor de la esfera.
* Texto: “Reproduciendo traducción…”

Utilizar Web Audio API y AnalyserNode donde estén disponibles para analizar la intensidad real del audio.

No utilizar únicamente animaciones aleatorias que simulen actividad cuando el sistema no esté escuchando o reproduciendo audio.

⸻

4. Avatares de los participantes

A ambos lados de la esfera aparecerán los participantes de la conversación.

Funcionalidades

* Mostrar avatar o iniciales de cada participante.
* Identificar qué participante está hablando.
* Mostrar el estado: Escuchando, Hablando o En espera.
* Iluminar el borde del avatar activo.
* Atenuar el avatar del participante que no está hablando.
* Permitir elegir avatares genéricos sin necesidad de fotografías.

Animación: borde dorado pulsante cuando el participante tenga actividad de voz detectada.

En una conversación mediante un solo teléfono, los avatares representan los dos lados del diálogo. No se debe simular una llamada remota real si no existe conexión con otro usuario.

⸻

5. Traducción automática bidireccional

Esta será la funcionalidad más importante.

Funcionamiento

1. El usuario inicia la conversación.
2. La aplicación solicita permiso para utilizar el micrófono.
3. El servicio comienza a detectar la voz.
4. Identifica el idioma hablado entre los dos idiomas seleccionados.
5. Transcribe el audio original.
6. Traduce el contenido al otro idioma.
7. Genera el audio traducido mediante síntesis de voz.
8. Reproduce la traducción por el dispositivo de salida seleccionado.
9. Muestra ambas versiones en el historial.
10. Continúa escuchando hasta que el usuario pause o termine la conversación.

Requisitos técnicos

* Conexión de audio de baja latencia.
* Reconocimiento de voz continuo mediante el proveedor de IA.
* Detección de turnos mediante VAD (Voice Activity Detection).
* Traducción contextual.
* Síntesis de voz natural.
* Control de interrupciones y turnos simultáneos.
* Protección contra el eco del audio traducido.
* Reconexión automática ante errores temporales.
* Manejo explícito de silencios y pausas.

La aplicación debe diferenciar entre el idioma detectado y la identidad del hablante. No debe asumir que reconocer inglés significa identificar automáticamente a una persona concreta.

La traducción deberá utilizar una API real conectada a un backend seguro, nunca respuestas ficticias.

⸻

6. Tarjetas de conversación traducida

Cada intervención aparecerá como una tarjeta elegante con efecto glassmorphism.

Información

* Avatar del participante.
* Idioma original.
* Texto original.
* Traducción.
* Hora.
* Estado de procesamiento.
* Botón de reproducir audio traducido.

Funcionalidad JavaScript

* Crear automáticamente una tarjeta por intervención.
* Mostrar transcripciones parciales mientras se reconoce la voz.
* Actualizar el texto al obtener la transcripción definitiva.
* Incorporar la traducción al estar disponible.
* Permitir escuchar nuevamente el audio.
* Permitir copiar el texto.
* Permitir guardar una frase como favorita.
* Mostrar indicadores de error cuando falle la traducción.
* Mantener el orden cronológico.
* Desplazamiento automático hacia el mensaje más reciente, excepto cuando el usuario esté revisando mensajes antiguos.

Efectos

* Aparición mediante fade-in.
* Desplazamiento vertical de 12 px.
* Duración de 250 ms.
* Destello dorado discreto al completar la traducción.

No crear mensajes duplicados durante las actualizaciones de una transcripción parcial.

⸻

7. Botón Micrófono

Ubicación: parte inferior izquierda.

Funcionalidad

Al presionarlo:

* Activar o silenciar la captura del micrófono.
* Cambiar el icono según su estado.
* Detener el envío de audio cuando esté silenciado.
* Mostrar visualmente “Micrófono desactivado”.
* Mantener visible el historial existente.

Animación: cambio suave de borde dorado a borde gris.

El micrófono silenciado no debe seguir transmitiendo audio al proveedor.

⸻

8. Botón Speaker / Audio

Permite controlar la reproducción de las traducciones.

Funcionalidad

* Activar o desactivar la reproducción automática.
* Mantener la visualización del texto aunque el audio esté desactivado.
* Mostrar el estado de reproducción.
* Utilizar el dispositivo de salida disponible según las capacidades del sistema.
* Respetar las limitaciones de iOS, Android y navegadores.

Si existen varios dispositivos compatibles, ofrecer selección de salida cuando la plataforma lo permita.

Efecto: iluminación dorada cuando la reproducción automática esté activada.

⸻

9. Botón central Pause / Resume

Este botón será el más destacado de la barra inferior.

Al presionar Pause

* Detener la captura y el envío de nuevos fragmentos de audio.
* Mantener el historial.
* Conservar el tiempo acumulado de uso.
* Mostrar “Conversación pausada”.
* Detener la animación principal y mantener un halo luminoso tenue.

Al presionar Resume

* Reactivar la captura de audio.
* Restablecer la conexión si fuera necesario.
* Continuar registrando la conversación.
* Reactivar las ondas de sonido.

Efecto visual: transición entre símbolo de pausa y reproducción con animación de escala.

⸻

10. Botón Switch

Este botón permite intercambiar los idiomas de origen y destino sin salir de la conversación.

Funcionalidad

* Intercambiar ambos idiomas.
* Actualizar banderas y etiquetas.
* Reconfigurar los servicios de voz.
* Conservar el historial.
* Mostrar confirmación visual breve.

Efecto: rotación de flechas con iluminación dorada.

⸻

11. Botón rojo End Conversation

Finaliza la sesión activa.

Funcionalidad

Al presionarlo:

* Abrir un modal de confirmación.
* Mostrar opciones “Continuar conversación” y “Finalizar”.
* Al confirmar, detener micrófono, audio y conexión de tiempo real.
* Finalizar la medición de uso.
* Registrar los minutos facturables según las reglas del proveedor y del plan.
* Mostrar un resumen de sesión.

Resumen final

* Duración total.
* Idiomas utilizados.
* Número de intervenciones.
* Frases traducidas.
* Minutos consumidos.
* Botones “Guardar conversación”, “Guardar frases” y “Nueva conversación”.

Las conversaciones no deben guardarse permanentemente sin consentimiento y controles de privacidad adecuados.

⸻

12. Reproductor y barra de audio

La barra horizontal situada encima de los botones funcionará como un reproductor de intervenciones.

Funcionalidades

* Representar visualmente la onda del audio disponible.
* Mostrar tiempo transcurrido y duración.
* Permitir reproducir o pausar el audio de una intervención.
* Permitir desplazarse por el audio cuando exista una grabación reproducible.
* Resaltar en dorado el progreso de reproducción.
* Sincronizar la posición del reproductor con el audio.

Si la aplicación no guarda audio, mostrar únicamente un indicador de actividad en vivo, sin simular una grabación reproducible.

⸻

13. Botón de configuración

Ubicación: esquina superior derecha.

Abrir un panel con:

* Idioma de la interfaz.
* Voz de traducción.
* Velocidad de reproducción.
* Reproducción automática.
* Sensibilidad del micrófono, cuando el proveedor lo permita.
* Reducción de ruido compatible.
* Preferencias de audio.
* Guardado del historial.
* Privacidad y eliminación de conversaciones.

Las configuraciones deberán conservarse entre sesiones del usuario.

⸻

14. Animaciones Luxury Premium

Implementar los siguientes efectos:

Glassmorphism

* Superficies semitransparentes.
* Desenfoque de fondo.
* Bordes sutiles.
* Sombras elegantes.

Gold Glow

* Iluminación dorada en botones activos.
* Halo dinámico en la esfera de voz.
* Resplandor controlado en los indicadores.

Audio Reactive

* Ondas sincronizadas con audio real.
* Cambios de intensidad según volumen.
* Movimiento fluido sin saltos.

Microinteracciones

* Botones con efecto de presión.
* Transiciones de 200–350 ms.
* Estados de carga visibles.
* Retroalimentación háptica en dispositivos compatibles.

Respetar la configuración del sistema para reducir movimiento y mantener buen rendimiento en dispositivos de gama media.

⸻

15. Consumo de minutos y suscripción

La pantalla debe estar vinculada al sistema de suscripciones de la aplicación.

Funcionalidad

* Verificar el plan antes de iniciar.
* Comprobar los minutos disponibles.
* Mostrar el tiempo consumido.
* Registrar el consumo desde el servidor.
* Avisar cuando los minutos estén por agotarse.
* Ofrecer adquirir minutos adicionales.
* Detener nuevas sesiones cuando no exista saldo autorizado.

La contabilidad de minutos debe realizarse en el backend para impedir modificaciones fraudulentas desde JavaScript en el navegador.

No asumir que la duración de la sesión y los minutos facturables por el proveedor son necesariamente iguales.

⸻

16. Seguridad y privacidad

Implementar obligatoriamente:

* Autenticación segura.
* Tokens temporales para conexiones de audio.
* Claves de API exclusivamente en el servidor.
* Permisos explícitos de micrófono.
* Indicadores claros de grabación y escucha.
* Cifrado de comunicaciones.
* Control de acceso a conversaciones por usuario.
* Eliminación de sesiones y datos guardados.
* Protección contra abuso de la API.
* Límites de consumo y costos.
* Consentimiento adecuado para grabación y almacenamiento.
* Manejo seguro de desconexiones.

No registrar audio ni transcripciones sensibles en logs de depuración.

⸻

17. Estados generales de la aplicación

El JavaScript deberá gestionar claramente estos estados:

* idle: conversación sin iniciar.
* requesting_permission: solicitando micrófono.
* connecting: estableciendo conexión.
* listening: escuchando.
* processing: procesando audio.
* translating: traduciendo.
* speaking: reproduciendo traducción.
* paused: conversación pausada.
* reconnecting: recuperando conexión.
* error: error controlado.
* ended: conversación finalizada.

Todos los elementos visuales deben actualizarse de forma sincronizada con estos estados.

⸻

18. Resultado final esperado

Quiero una interfaz completamente funcional, no solamente una animación visual.

La pantalla debe sentirse como una llamada premium con inteligencia artificial.

Al comenzar la conversación, el usuario debe experimentar una interfaz fluida, capaz de escuchar, traducir y reproducir los mensajes en ambos idiomas, mostrando simultáneamente las transcripciones.

La esfera, las ondas, los avatares, los controles y el historial deben responder al estado real del sistema.

Mantener exactamente la identidad visual Luxury Premium de la imagen: negro azulado, dorado, glassmorphism, iluminación elegante y componentes redondeados.

No reemplazar esta interfaz por un chat tradicional.

La aplicación debe funcionar en web, iOS y Android, utilizando implementaciones específicas cuando las capacidades de audio sean diferentes entre plataformas.

<!-- redeploy 2026-10-23: STRIPE_SECRET_KEY agregada en Vercel -->
