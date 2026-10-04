// Adds a "choose video to upload" button next to the "video" widget
// for VHS_LoadVideoFromFilenames, matching the standard VHS behavior.
// Also displays source video information below the widget.

import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "vhs_metadata_loader.VideoUpload",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "VHS_LoadVideoFromFilenames") {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        const onExecuted = nodeType.prototype.onExecuted;

        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            const videoWidget = this.widgets?.find((w) => w.name === "video");
            if (!videoWidget) {
                return result;
            }

            const infoElement = document.createElement("div");
            infoElement.style.cssText = [
                "padding: 4px 8px",
                "font-size: 12px",
                "line-height: 18px",
                "text-align: center",
                "white-space: nowrap",
                "overflow: hidden",
                "text-overflow: ellipsis",
                "color: var(--descrip-text, #aaa)",
                "box-sizing: border-box",
                "width: 100%",
            ].join(";");

            // "video_info_display" is an internal DOM-widget name only.
            const infoWidget = this.addDOMWidget(
                "video_info_display",
                "display",
                infoElement,
                { serialize: false }
            );
            infoWidget.options = infoWidget.options || {};
            infoWidget.options.serialize = false;
            infoWidget.computeSize = () => [this.size[0], 26];

            const clearVideoInfo = () => {
                infoElement.textContent = "";
                app.graph.setDirtyCanvas(true, true);
            };

            const showVideoInfo = (source) => {
                if (!source) {
                    clearVideoInfo();
                    return;
                }

                const frames = Number(source.frames);
                const fps = Number(source.fps);
                const size = Array.isArray(source.size) ? source.size : null;
                const width = size ? Number(size[0]) : 0;
                const height = size ? Number(size[1]) : 0;

                if (!Number.isFinite(frames) || !Number.isFinite(fps) ||
                    !Number.isFinite(width) || !Number.isFinite(height) ||
                    frames <= 0 || fps <= 0 || width <= 0 || height <= 0) {
                    clearVideoInfo();
                    return;
                }

                infoElement.textContent =
                    `Frames: ${Math.round(frames)} | FPS: ${fps.toFixed(2)} | Size: ${Math.round(width)} × ${Math.round(height)}`;

                app.graph.setDirtyCanvas(true, true);
            };

            const queryVideoInfo = async (value) => {
                if (!value) {
                    clearVideoInfo();
                    return;
                }

                try {
                    const params = new URLSearchParams();
                    params.set("filename", value);
                    params.set("type", "input");

                    // Query the official VHS metadata endpoint.
                    const response = await fetch(`/vhs/queryvideo?${params.toString()}`, {
                        cache: "no-store",
                    });

                    if (!response.ok) {
                        clearVideoInfo();
                        return;
                    }

                    const data = await response.json();
                    showVideoInfo(data?.source);
                } catch (err) {
                    clearVideoInfo();
                }
            };

            const originalCallback = videoWidget.callback;
            videoWidget.callback = function () {
                if (originalCallback) {
                    originalCallback.apply(this, arguments);
                }
                queryVideoInfo(videoWidget.value);
            };

            // Show information for an already selected video.
            queryVideoInfo(videoWidget.value);

            const uploadWidget = this.addWidget(
                "button",
                "video_upload_button",
                "choose video to upload",
                () => {
                    const fileInput = document.createElement("input");
                    fileInput.type = "file";
                    fileInput.accept = "video/*";
                    fileInput.style.display = "none";

                    fileInput.onchange = async () => {
                        if (!fileInput.files || !fileInput.files.length) {
                            return;
                        }
                        const file = fileInput.files[0];

                        const body = new FormData();
                        body.append("image", file);
                        body.append("subfolder", "");
                        body.append("type", "input");

                        try {
                            const resp = await fetch("/upload/image", {
                                method: "POST",
                                body,
                            });
                            if (resp.status !== 200) {
                                const text = await resp.text();
                                alert("Video upload error: " + text);
                                return;
                            }
                            const data = await resp.json();
                            let path = data.name;
                            if (data.subfolder) {
                                path = data.subfolder + "/" + path;
                            }
                            if (!videoWidget.options.values.includes(path)) {
                                videoWidget.options.values.push(path);
                            }
                            videoWidget.value = path;
                            if (videoWidget.callback) {
                                videoWidget.callback(path);
                            }
                            app.graph.setDirtyCanvas(true, true);
                        } catch (err) {
                            alert("Video upload error: " + err);
                        }
                    };

                    document.body.append(fileInput);
                    fileInput.click();
                    setTimeout(() => fileInput.remove(), 0);
                },
                { serialize: false }
            );
            uploadWidget.options = uploadWidget.options || {};
            uploadWidget.options.serialize = false;

            return result;
        };

        // When filenames is connected, the selected video widget may be empty.
        // The node sends the same VHS_VIDEOINFO values through the UI payload
        // after execution so the display still shows the current source video.
        nodeType.prototype.onExecuted = function (message) {
            const result = onExecuted ? onExecuted.apply(this, arguments) : undefined;
            const sourceInfo = message?.video_info?.[0] ?? message?.video_info;
            const infoWidget = this.widgets?.find(
                (w) => w.name === "video_info_display"
            );
            const infoElement = infoWidget?.element;

            if (sourceInfo && infoElement) {
                const frames = Number(sourceInfo.source_frame_count ?? sourceInfo.frames);
                const fps = Number(sourceInfo.source_fps ?? sourceInfo.fps);
                const width = Number(sourceInfo.source_width ?? sourceInfo.size?.[0]);
                const height = Number(sourceInfo.source_height ?? sourceInfo.size?.[1]);

                if (Number.isFinite(frames) && Number.isFinite(fps) &&
                    Number.isFinite(width) && Number.isFinite(height) &&
                    frames > 0 && fps > 0 && width > 0 && height > 0) {
                    infoElement.textContent =
                        `Frames: ${Math.round(frames)} | FPS: ${fps.toFixed(2)} | Size: ${Math.round(width)} × ${Math.round(height)}`;
                    app.graph.setDirtyCanvas(true, true);
                }
            }

            return result;
        };
    },
});
