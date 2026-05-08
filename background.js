async function getDeviceId() {
  const result = await chrome.storage.local.get(['deviceId']);
  if (result.deviceId) {
    return result.deviceId;
  }
  const newId = self.crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: newId });
  return newId;
}
const globalHeaders = {
  // We cannot easily spoof some of these headers in a browser environment due to browser security restrictions.
  // We will let the browser handle standard headers (User-Agent, Origin, etc.) for fetch.
};

function getURLSearchParams(params) {
  return Object.entries(params).reduce((acc, [key, val]) => {
    if (acc) {
      acc += '&'
    }
    acc += `${key}=${encodeURIComponent(val).replace('!', '%21')}`
    return acc;
  }, '');
}

async function loginToFinanda(username, password) {
  const deviceId = await getDeviceId();
  const body = getURLSearchParams({
    password: password,
    device: `Chrome-${deviceId}`,
    version: '1.63',
    appVersion: '1.73',
    checkSubscription: 'true',
    caller: 'web',
    userid: username,
  });

  console.log('Sending login request...', { username });

  try {
    let response = await fetch('https://cloud.finanda.co.il/login', {
      method: 'POST',
      headers: {
        ...globalHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body
    });

    const dataText = await response.text();
    console.log('Part-1 auth with user and password response:', dataText);
    
    let data;
    try {
      data = JSON.parse(dataText);
    } catch (e) {
      throw new Error(`Failed to parse login response: ${response.status} ${dataText}`);
    }

    if (response.status === 400 && data.errorMessage === "authentication-required") {
      console.log('MFA Required. Requesting MFA code...');
      const mfaBody = getURLSearchParams({
        encSession: data.session,
        mfaMethod: data.authenticationMethods[0].type,
        encMfaInput: data.authenticationMethods[0].value,
        validationTyp: 'user' // Note: typo in original script 'validationTyp', preserving it just in case
      });

      const mfaResponse = await fetch('https://cloud.finanda.co.il/requestMFA', {
        method: 'POST',
        headers: {
          ...globalHeaders,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: mfaBody
      });

      console.log('Part-2 generate mfa code response:', await mfaResponse.text());

      if (mfaResponse.status === 200) {
        // Return state indicating MFA is needed, along with the encSession to pass back later
        return { 
          status: 'MFA_REQUIRED', 
          session: data.session 
        };
      } else {
        throw new Error(`MFA request failed. Status code: ${mfaResponse.status}`);
      }
    }

    if (!data.success) {
      throw new Error('Login data success flag is false or undefined.');
    }
    if (data.userStatus !== 'verified') {
      throw new Error(`userStatus is not verified: ${data.userStatus}`);
    }

    if (data.session) {
       // Save session to chrome storage
       await chrome.storage.local.set({ finandaSession: data.session });
       console.log('Session saved successfully.');
       return { status: 'SUCCESS', session: data.session };
    } else {
      throw new Error('Session is empty in response.');
    }

  } catch (error) {
    console.error('Login error:', error);
    return { status: 'ERROR', message: error.message };
  }
}


async function verifyMfa(session, mfaCode, username, password) {
  try {
     const deviceId = await getDeviceId();
     const mfaAuthBody = getURLSearchParams({
        encSession: session,
        device: `Chrome-${deviceId}`,
        mfaCode: mfaCode,
        validationType: 'user'
      });

      const mfaAuthResponse = await fetch('https://cloud.finanda.co.il/authenticateMFA', {
        method: 'POST',
        headers: {
          ...globalHeaders,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: mfaAuthBody
      });

      console.log('Part-3 auth with mfa code response:', await mfaAuthResponse.text());

      if (mfaAuthResponse.status === 200) {
        // Now re-login with username/password as per original flow
        const body = getURLSearchParams({
          password: password,
          device: `Chrome-${deviceId}`,
          version: '1.63',
          appVersion: '1.73',
          checkSubscription: 'true',
          caller: 'web',
          userid: username,
        });

        const finalLoginResponse = await fetch('https://cloud.finanda.co.il/login', {
          method: 'POST',
          headers: {
            ...globalHeaders,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body
        });
        
        const finalDataText = await finalLoginResponse.text();
        console.log('Part-4 RE-auth user and password:', finalDataText);
        const data = JSON.parse(finalDataText);

        if (data.success && data.session) {
           await chrome.storage.local.set({ finandaSession: data.session });
           return { status: 'SUCCESS', session: data.session };
        } else {
           throw new Error('Final login after MFA failed.');
        }

      } else {
        throw new Error(`Wrong MFA code. Status code: ${mfaAuthResponse.status}`);
      }
  } catch (error) {
     console.error('MFA Verification error:', error);
     return { status: 'ERROR', message: error.message };
  }
}

async function getProfileInitiation(sessionId) {
  try {
    const response = await fetch('https://cloud.finanda.co.il/profileInitiation', {
      method: 'POST',
      headers: {
        ...globalHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: getURLSearchParams({
        caller: 'web',
        session: sessionId,
      })
    });
    
    const text = await response.text();
    if (response.status !== 200) {
      throw new Error(`profileInitiation failed. status code: ${response.status}, ${text}`);
    }

    const data = JSON.parse(text);

    if (!data.success) {
      throw new Error(`Profile initiation unsucessful: ${JSON.stringify(data)}`);
    }

    return { status: 'SUCCESS', data: data };

  } catch (error) {
     console.error('Profile Initiation error:', error);
     return { status: 'ERROR', message: error.message };
  }
}


// Listen for messages from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("Background received message:", request);

  if (request.action === 'FINANDA_LOGIN') {
    loginToFinanda(request.username, request.password).then(result => {
        if (result.status === 'SUCCESS') {
            // Automatically fetch data after successful login
            getProfileInitiation(result.session).then(profileResult => {
                sendResponse(profileResult);
            });
        } else {
            // Return MFA_REQUIRED or ERROR
            sendResponse(result);
        }
    });
    return true; // Indicates we will send response asynchronously
  }

  if (request.action === 'FINANDA_MFA_VERIFY') {
     verifyMfa(request.session, request.mfaCode, request.username, request.password).then(result => {
         if (result.status === 'SUCCESS') {
             // Automatically fetch data after successful MFA verify & re-login
            getProfileInitiation(result.session).then(profileResult => {
                sendResponse(profileResult);
            });
         } else {
             sendResponse(result);
         }
     });
     return true;
  }

   if (request.action === 'FINANDA_FETCH_DATA') {
      // Just in case they want to fetch data later using a cached session
      chrome.storage.local.get(['finandaSession'], (result) => {
          if (result.finandaSession) {
               getProfileInitiation(result.finandaSession).then(profileResult => {
                  sendResponse(profileResult);
              });
          } else {
              sendResponse({ status: 'ERROR', message: 'No session found. Please login first.'});
          }
      });
      return true;
  }
});
