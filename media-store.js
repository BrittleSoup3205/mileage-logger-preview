(() => {
  "use strict";

  const DB_NAME = "MileageLoggerInspectionMedia";
  const DB_VERSION = 1;
  const STORE_NAME = "photos";
  const MAX_IMAGE_DIMENSION = 1600;
  const JPEG_QUALITY = 0.82;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("Private photo storage is not supported by this browser."));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("inspectionId", "inspectionId", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Private photo storage could not be opened."));
    });
  }

  async function withStore(mode, callback) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let result;

      try {
        result = callback(store);
      } catch (error) {
        database.close();
        reject(error);
        return;
      }

      transaction.oncomplete = () => {
        database.close();
        resolve(result);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("The photo operation failed."));
      };
      transaction.onabort = transaction.onerror;
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("The photo request failed."));
    });
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return `photo-${window.crypto.randomUUID()}`;
    }
    return `photo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`The photo "${file.name || "image"}" could not be read.`));
      };
      image.src = url;
    });
  }

  async function compressImage(file) {
    const image = await loadImage(file);
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => result ? resolve(result) : reject(new Error("The photo could not be compressed.")),
        "image/jpeg",
        JPEG_QUALITY
      );
    });

    return { blob, width, height };
  }

  async function addPhoto(inspectionId, file) {
    if (!inspectionId) throw new Error("Save or open an inspection before adding a photo.");
    if (!file || !String(file.type || "").startsWith("image/")) {
      throw new Error("Choose an image file.");
    }

    let prepared;
    try {
      prepared = await compressImage(file);
    } catch (error) {
      prepared = { blob: file, width: null, height: null };
    }

    const record = {
      id: makeId(),
      inspectionId,
      name: String(file.name || `inspection-photo-${Date.now()}.jpg`),
      type: prepared.blob.type || file.type || "image/jpeg",
      size: prepared.blob.size,
      width: prepared.width,
      height: prepared.height,
      createdISO: new Date().toISOString(),
      caption: "",
      blob: prepared.blob
    };

    await withStore("readwrite", (store) => store.put(record));
    return {
      id: record.id,
      name: record.name,
      type: record.type,
      size: record.size,
      width: record.width,
      height: record.height,
      createdISO: record.createdISO,
      caption: record.caption
    };
  }

  async function getPhoto(id) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      return await requestResult(transaction.objectStore(STORE_NAME).get(id));
    } finally {
      database.close();
    }
  }

  async function getAllPhotos() {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      return await requestResult(transaction.objectStore(STORE_NAME).getAll());
    } finally {
      database.close();
    }
  }

  async function deletePhoto(id) {
    await withStore("readwrite", (store) => store.delete(id));
  }

  async function deleteInspectionPhotos(inspectionId) {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const index = transaction.objectStore(STORE_NAME).index("inspectionId");
        const cursorRequest = index.openCursor(IDBKeyRange.only(inspectionId));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Photos could not be removed."));
      });
    } finally {
      database.close();
    }
  }

  async function replaceAllPhotos(records) {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        store.clear();
        for (const record of records) store.put(record);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Photos could not be restored."));
      });
    } finally {
      database.close();
    }
  }

  window.MileageMediaStore = {
    addPhoto,
    getPhoto,
    getAllPhotos,
    deletePhoto,
    deleteInspectionPhotos,
    replaceAllPhotos
  };
})();
